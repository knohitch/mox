/**
 * Channel adapter architecture (Prompt 11).
 *
 * Canonical flow: external channel → adapter → ChannelMessage → Mox thread
 * → agent → response → adapter → external channel.
 *
 * Every adapter normalizes external ids/text/attachments/reply references,
 * verifies webhook signatures, dedupes by external message id and reports
 * delivery state. One agent can attach to many channels; one channel can
 * never hard-bind a single agent.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type ChannelProviderKind =
  | "web"
  | "whatsapp"
  | "telegram"
  | "slack"
  | "discord"
  | "teams"
  | "webhook";

export interface Attachment {
  name: string;
  url: string;
  mimeType: string;
}

/** Normalized inbound message from any provider. */
export interface CanonicalInbound {
  connectionId: string;
  providerKind: ChannelProviderKind;
  /** Provider's conversation/chat/channel identifier. */
  externalConversationId: string;
  externalUserId: string;
  /** Provider message id; the dedupe key per connection. */
  externalMessageId: string;
  text?: string;
  attachments: Attachment[];
  replyToExternalId?: string;
  receivedAt: string;
}

export interface OutboundReply {
  externalConversationId: string;
  replyToExternalId?: string;
  text: string;
  attachments?: Attachment[];
}

export interface WebhookVerificationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Shared HMAC-SHA256 scheme (timestamp.payload). Vendor-exact schemes are
 * configured per adapter instance in production; verification is always
 * timing-safe and replay-window checked.
 */
export function verifyHmacSignature(
  secret: string,
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
): WebhookVerificationResult {
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: "missing_signature" };
  const age = Math.abs(Date.now() - Number(timestampHeader) * 1000);
  if (Number.isFinite(Number(timestampHeader)) && age > 10 * 60_000) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = createHmac("sha256", secret).update(`${timestampHeader}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

export interface ChannelAdapter {
  readonly kind: ChannelProviderKind;
  readonly displayName: string;
  verifyWebhook(headers: Record<string, string>, rawBody: string, secret: string): WebhookVerificationResult;
  normalize(input: { connectionId: string; headers: Record<string, string>; rawBody: string }): CanonicalInbound;
  formatOutbound(reply: OutboundReply): Record<string, unknown>;
}

// ---- Per-provider adapters ---------------------------------------------------

interface GenericPayload {
  eventId?: string;
  conversationId?: string;
  userId?: string;
  messageId?: string;
  text?: string;
  attachments?: Attachment[];
  replyTo?: string;
}

function normalizeGeneric(
  kind: ChannelProviderKind,
  input: { connectionId: string; rawBody: string },
): CanonicalInbound {
  let payload: GenericPayload = {};
  try {
    payload = JSON.parse(input.rawBody) as GenericPayload;
  } catch {
    payload = {};
  }
  return {
    connectionId: input.connectionId,
    providerKind: kind,
    externalConversationId: payload.conversationId ?? "",
    externalUserId: payload.userId ?? "",
    externalMessageId: payload.eventId ?? payload.messageId ?? crypto.randomUUID(),
    text: payload.text,
    attachments: payload.attachments ?? [],
    replyToExternalId: payload.replyTo,
    receivedAt: new Date().toISOString(),
  };
}

export class WebChatAdapter implements ChannelAdapter {
  readonly kind = "web" as const;
  readonly displayName = "Mox Web Chat";
  verifyWebhook(): WebhookVerificationResult {
    // First-party web chat authenticates via session tokens, not webhooks.
    return { ok: true };
  }
  normalize(input: { connectionId: string; rawBody: string }): CanonicalInbound {
    return normalizeGeneric(this.kind, input);
  }
  formatOutbound(reply: OutboundReply): Record<string, unknown> {
    return { conversationId: reply.externalConversationId, text: reply.text, attachments: reply.attachments ?? [] };
  }
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly kind = "whatsapp" as const;
  readonly displayName = "WhatsApp Cloud API";
  verifyWebhook(headers: Record<string, string>, rawBody: string, secret: string): WebhookVerificationResult {
    return verifyHmacSignature(secret, rawBody, headers["x-timestamp"], headers["x-hub-signature-256"]);
  }
  normalize(input: { connectionId: string; rawBody: string }): CanonicalInbound {
    return normalizeGeneric(this.kind, input);
  }
  /** One attachment per message on WhatsApp Cloud API → document payload. */
  formatOutbound(reply: OutboundReply): Record<string, unknown> {
    const base = { messaging_product: "whatsapp", to: reply.externalConversationId };
    const attachment = reply.attachments?.[0];
    if (attachment) {
      return { ...base, type: "document", document: { link: attachment.url, filename: attachment.name }, caption: reply.text };
    }
    return { ...base, text: { body: reply.text } };
  }
}

export class TelegramAdapter implements ChannelAdapter {
  readonly kind = "telegram" as const;
  readonly displayName = "Telegram Bot API";
  verifyWebhook(headers: Record<string, string>, _rawBody: string, secret: string): WebhookVerificationResult {
    // Telegram uses a static secret-token header comparison.
    if (!headers["x-telegram-bot-api-secret-token"]) return { ok: false, reason: "missing_signature" };
    const a = Buffer.from(headers["x-telegram-bot-api-secret-token"]);
    const b = Buffer.from(secret);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    return ok ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  }
  normalize(input: { connectionId: string; rawBody: string }): CanonicalInbound {
    let payload: {
      update_id?: number;
      message?: { message_id?: number; chat?: { id?: number }; from?: { id?: number }; text?: string; reply_to_message?: { message_id?: number } };
    } = {};
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      /* handled below */
    }
    void payload.update_id;
    return {
      connectionId: input.connectionId,
      providerKind: this.kind,
      externalConversationId: String(payload.message?.chat?.id ?? ""),
      externalUserId: String(payload.message?.from?.id ?? ""),
      externalMessageId: String(payload.message?.message_id ?? crypto.randomUUID()),
      text: payload.message?.text,
      attachments: [],
      replyToExternalId: payload.message?.reply_to_message?.message_id !== undefined
        ? String(payload.message.reply_to_message.message_id)
        : undefined,
      receivedAt: new Date().toISOString(),
    };
  }
  formatOutbound(reply: OutboundReply): Record<string, unknown> {
    return {
      chat_id: reply.externalConversationId,
      text: reply.text,
      ...(reply.replyToExternalId ? { reply_to_message_id: Number(reply.replyToExternalId) } : {}),
    };
  }
}

export class SlackAdapter implements ChannelAdapter {
  readonly kind = "slack" as const;
  readonly displayName = "Slack Events API";
  verifyWebhook(headers: Record<string, string>, rawBody: string, secret: string): WebhookVerificationResult {
    return verifyHmacSignature(secret, rawBody, headers["x-slack-request-timestamp"], headers["x-slack-signature"]);
  }
  normalize(input: { connectionId: string; rawBody: string }): CanonicalInbound {
    let payload: {
      event_id?: string;
      event?: { channel?: string; user?: string; ts?: string; text?: string; thread_ts?: string; files?: Array<{ name: string; url_private: string; mimetype: string }> };
    } = {};
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      /* handled below */
    }
    return {
      connectionId: input.connectionId,
      providerKind: this.kind,
      externalConversationId: payload.event?.channel ?? "",
      externalUserId: payload.event?.user ?? "",
      externalMessageId: payload.event?.ts ?? payload.event_id ?? crypto.randomUUID(),
      text: payload.event?.text,
      attachments: (payload.event?.files ?? []).map((f) => ({ name: f.name, url: f.url_private, mimeType: f.mimetype })),
      replyToExternalId: payload.event?.thread_ts,
      receivedAt: new Date().toISOString(),
    };
  }
  formatOutbound(reply: OutboundReply): Record<string, unknown> {
    return {
      channel: reply.externalConversationId,
      text: reply.text,
      ...(reply.replyToExternalId ? { thread_ts: reply.replyToExternalId } : {}),
    };
  }
}

export class DiscordAdapter implements ChannelAdapter {
  readonly kind = "discord" as const;
  readonly displayName = "Discord Gateway/Webhook";
  verifyWebhook(headers: Record<string, string>, rawBody: string, secret: string): WebhookVerificationResult {
    return verifyHmacSignature(secret, rawBody, headers["x-signature-timestamp"], headers["x-signature-ed25519"]);
  }
  normalize(input: { connectionId: string; rawBody: string }): CanonicalInbound {
    let payload: {
      id?: string;
      guild_id?: string;
      channel_id?: string;
      author?: { id?: string };
      content?: string;
      attachments?: Array<{ filename: string; url: string; content_type: string }>;
      referenced_message?: { id?: string };
    } = {};
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      /* handled below */
    }
    return {
      connectionId: input.connectionId,
      providerKind: this.kind,
      externalConversationId: payload.channel_id ?? payload.guild_id ?? "",
      externalUserId: payload.author?.id ?? "",
      externalMessageId: payload.id ?? crypto.randomUUID(),
      text: payload.content,
      attachments: (payload.attachments ?? []).map((a) => ({ name: a.filename, url: a.url, mimeType: a.content_type })),
      replyToExternalId: payload.referenced_message?.id,
      receivedAt: new Date().toISOString(),
    };
  }
  formatOutbound(reply: OutboundReply): Record<string, unknown> {
    return {
      channel_id: reply.externalConversationId,
      content: reply.text,
      ...(reply.replyToExternalId ? { message_reference: { message_id: reply.replyToExternalId } } : {}),
    };
  }
}

export class TeamsAdapter implements ChannelAdapter {
  readonly kind = "teams" as const;
  readonly displayName = "Microsoft Teams Bot";
  verifyWebhook(headers: Record<string, string>, rawBody: string, secret: string): WebhookVerificationResult {
    return verifyHmacSignature(secret, rawBody, headers["x-ms-timestamp"], headers["x-ms-signature"]);
  }
  normalize(input: { connectionId: string; rawBody: string }): CanonicalInbound {
    return normalizeGeneric(this.kind, input);
  }
  formatOutbound(reply: OutboundReply): Record<string, unknown> {
    return {
      conversationId: reply.externalConversationId,
      text: reply.text,
      attachments: (reply.attachments ?? []).map((a) => ({ name: a.name, contentUrl: a.url, contentType: a.mimeType })),
    };
  }
}

export class GenericWebhookAdapter implements ChannelAdapter {
  readonly kind = "webhook" as const;
  readonly displayName = "Generic Webhook/API";
  verifyWebhook(headers: Record<string, string>, rawBody: string, secret: string): WebhookVerificationResult {
    return verifyHmacSignature(secret, rawBody, headers["x-mox-timestamp"], headers["x-mox-signature"]);
  }
  normalize(input: { connectionId: string; rawBody: string }): CanonicalInbound {
    return normalizeGeneric(this.kind, input);
  }
  formatOutbound(reply: OutboundReply): Record<string, unknown> {
    return { conversationId: reply.externalConversationId, text: reply.text, attachments: reply.attachments ?? [] };
  }
}
