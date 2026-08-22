import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  ChannelGateway,
  InMemoryChannelStore,
  TelegramAdapter,
  WhatsAppAdapter,
  type OutboundTransport,
} from "../src/index.js";

function signedHeaders(raw: string, secret: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  return { "x-timestamp": ts, "x-hub-signature-256": sig };
}

async function gatewayWith(transport?: Partial<OutboundTransport>) {
  const gateway = new ChannelGateway(new InMemoryChannelStore(), {
    async send(connection, payload) {
      void transport;
      void connection;
      void payload;
      return { delivered: true };
    },
    ...transport,
  });
  gateway.registerAdapter(new WhatsAppAdapter());
  gateway.registerAdapter(new TelegramAdapter());
  await gateway.attach({
    connectionId: "conn-wa",
    orgId: "org-1",
    agentId: "agent-1",
    kind: "whatsapp",
    secretRef: "vault://wa",
    outboundUrl: "https://graph.example.test/messages",
  });
  await gateway.attach({
    connectionId: "conn-tg",
    orgId: "org-1",
    agentId: "agent-2",
    kind: "telegram",
    secretRef: "vault://tg",
    outboundUrl: "https://api.telegram.example/bot/sendMessage",
  });
  gateway.onReply(async (inbound, threadId) => ({
    text: `echo:${inbound.text ?? ""} (thread ${threadId})`,
  }));
  return { gateway };
}

describe("channel gateway", () => {
  it("processes a valid webhook end-to-end with conversation mapping", async () => {
    const { gateway } = await gatewayWith();
    const raw = JSON.stringify({ eventId: "m-1", conversationId: "wa-555", userId: "u-a", text: "hello" });
    const res = await gateway.handleWebhook({ connectionId: "conn-wa", headers: signedHeaders(raw, "vault-wa"), rawBody: raw, secret: "vault-wa" });
    expect(res.accepted).toBe(true);
    expect(res.threadId).toMatch(/^thr_/);
    // Same external conversation maps to the same Mox thread.
    const raw2 = JSON.stringify({ eventId: "m-2", conversationId: "wa-555", userId: "u-a", text: "again" });
    const res2 = await gateway.handleWebhook({ connectionId: "conn-wa", headers: signedHeaders(raw2, "vault-wa"), rawBody: raw2, secret: "vault-wa" });
    expect(res2.threadId).toBe(res.threadId);
  });

  it("rejects duplicate webhooks idempotently", async () => {
    const { gateway } = await gatewayWith();
    const raw = JSON.stringify({ eventId: "dup-1", conversationId: "c", userId: "u", text: "once" });
    const first = await gateway.handleWebhook({ connectionId: "conn-wa", headers: signedHeaders(raw, "k"), rawBody: raw, secret: "k" });
    expect(first.accepted).toBe(true);
    const replay = await gateway.handleWebhook({ connectionId: "conn-wa", headers: signedHeaders(raw, "k"), rawBody: raw, secret: "k" });
    expect(replay.accepted).toBe(false);
    expect(replay.reason).toBe("duplicate");
  });

  it("rejects bad signatures and flags the connection error state", async () => {
    const { gateway } = await gatewayWith();
    const raw = JSON.stringify({ eventId: "evil-1", conversationId: "c", userId: "u", text: "forged" });
    const forged = { ...signedHeaders(raw, "correct-key"), "x-hub-signature-256": "00".repeat(32) };
    const res = await gateway.handleWebhook({ connectionId: "conn-wa", headers: forged, rawBody: raw, secret: "correct-key" });
    expect(res).toEqual({ accepted: false, reason: "bad_signature" });
    const conn = await gateway.store.getConnection("conn-wa");
    expect(conn?.status).toBe("error");
  });

  it("carries attachments through normalization to outbound payloads", async () => {
    let captured: unknown;
    const gateway = new ChannelGateway(new InMemoryChannelStore(), {
      async send(_connection, payload) {
        captured = payload;
        return { delivered: true };
      },
    });
    gateway.registerAdapter(new WhatsAppAdapter());
    await gateway.attach({
      connectionId: "conn-wa2",
      orgId: "org-9",
      agentId: "agent-x",
      kind: "whatsapp",
      secretRef: "s",
      outboundUrl: "https://out.test",
    });
    gateway.onReply(async () => ({ text: "got it", attachments: [{ name: "report.pdf", url: "https://files.test/report.pdf", mimeType: "application/pdf" }] }));
    const raw = JSON.stringify({ eventId: "att-1", conversationId: "wa-c", userId: "u", text: "see attachment" });
    const res = await gateway.handleWebhook({ connectionId: "conn-wa2", headers: signedHeaders(raw, "s"), rawBody: raw, secret: "s" });
    expect(res.accepted).toBe(true);
    const doc = (captured as { document?: { filename?: string } }).document;
    expect(doc?.filename).toBe("report.pdf");
    expect((captured as { caption?: string }).caption).toBe("got it");
  });

  it("lets one agent attach to many channels and routes each correctly", async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    const gateway = new ChannelGateway(new InMemoryChannelStore(), {
      async send(_c, payload) {
        sentPayloads.push(payload);
        return { delivered: true };
      },
    });
    gateway.registerAdapter(new WhatsAppAdapter());
    gateway.registerAdapter(new TelegramAdapter());
    for (const [connectionId, kind] of [["ch-a", "whatsapp"], ["ch-b", "telegram"]] as const) {
      await gateway.attach({ connectionId, orgId: "org-m", agentId: "agent-multi", kind, secretRef: "s", outboundUrl: "https://out.test" });
    }
    gateway.onReply(async () => ({ text: "hi from the same agent" }));

    const waRaw = JSON.stringify({ eventId: "wm-1", conversationId: "wa-thread", userId: "u", text: "hey" });
    await gateway.handleWebhook({ connectionId: "ch-a", headers: signedHeaders(waRaw, "s"), rawBody: waRaw, secret: "s" });

    // Telegram verifies via its own static secret-token scheme.
    const tgRaw = JSON.stringify({ update_id: 7, message: { message_id: 42, chat: { id: 100 }, from: { id: 200 }, text: "tg hello" } });
    await gateway.handleWebhook({
      connectionId: "ch-b",
      headers: { "x-telegram-bot-api-secret-token": "s" },
      rawBody: tgRaw,
      secret: "s",
    });

    expect(sentPayloads[0]?.messaging_product).toBe("whatsapp");
    expect(sentPayloads[1]?.chat_id).toBe("100");
    expect(sentPayloads[1]?.reply_to_message_id).toBeUndefined();
  });

  it("maps telegram reply threading onto outbound replies", async () => {
    let captured: unknown;
    const gateway = new ChannelGateway(new InMemoryChannelStore(), {
      async send(_c, payload) {
        captured = payload;
        return { delivered: true };
      },
    });
    gateway.registerAdapter(new TelegramAdapter());
    await gateway.attach({ connectionId: "tg-r", orgId: "org", agentId: "a", kind: "telegram", secretRef: "s", outboundUrl: "https://o" });
    gateway.onReply(async () => ({ text: "threaded answer" }));
    const raw = JSON.stringify({ update_id: 8, message: { message_id: 43, chat: { id: 500 }, from: { id: 600 }, text: "?", reply_to_message: { message_id: 41 } } });
    await gateway.handleWebhook({ connectionId: "tg-r", headers: { "x-telegram-bot-api-secret-token": "s" }, rawBody: raw, secret: "s" });
    expect((captured as { reply_to_message_id?: number }).reply_to_message_id).toBe(41);
  });

  it("supports disconnect/reconnect cycles with honest paused handling", async () => {
    const { gateway } = await gatewayWith();
    await gateway.disconnect("conn-wa");
    const raw = JSON.stringify({ eventId: "pd-1", conversationId: "c", userId: "u", text: "hi" });
    const whilePaused = await gateway.handleWebhook({ connectionId: "conn-wa", headers: signedHeaders(raw, "k"), rawBody: raw, secret: "k" });
    expect(whilePaused).toEqual({ accepted: false, reason: "paused" });
    await gateway.reconnect("conn-wa");
    const afterReconnect = await gateway.handleWebhook({ connectionId: "conn-wa", headers: signedHeaders(raw, "k"), rawBody: raw, secret: "k" });
    expect(afterReconnect.accepted).toBe(true);
  });
});
