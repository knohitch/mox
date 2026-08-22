/**
 * Channel gateway (Prompt 11): connections, external-conversation mapping,
 * dedupe, delivery receipts and the inbound→agent→outbound pipeline.
 */

import type { ChannelAdapter, CanonicalInbound, OutboundReply } from "./adapters.js";

export interface ChannelConnectionRecord {
  connectionId: string;
  orgId: string;
  agentId: string;
  providerKind: string;
  secretRef: string;
  status: "active" | "paused" | "error";
  /** Outbound endpoint for webhook-style providers. */
  outboundUrl?: string;
  createdAt: string;
}

export interface ConversationMapping {
  connectionId: string;
  externalConversationId: string;
  threadId: string;
  externalParticipantId?: string;
}

export interface DeliveryReceipt {
  messageId: string;
  connectionId: string;
  externalConversationId: string;
  state: "queued" | "sent" | "failed";
  attempts: number;
  error?: string;
  at: string;
}

export interface ChannelStore {
  upsertConnection(connection: ChannelConnectionRecord): Promise<void>;
  getConnection(connectionId: string): Promise<ChannelConnectionRecord | undefined>;
  listConnections(orgId: string): Promise<ChannelConnectionRecord[]>;
  setStatus(connectionId: string, status: "active" | "paused" | "error"): Promise<void>;

  seenMessage(connectionId: string, externalMessageId: string): Promise<boolean>;

  getMapping(connectionId: string, externalConversationId: string): Promise<ConversationMapping | undefined>;
  putMapping(mapping: ConversationMapping): Promise<void>;

  recordReceipt(receipt: DeliveryReceipt): Promise<DeliveryReceipt>;
}

export class InMemoryChannelStore implements ChannelStore {
  private readonly connections = new Map<string, ChannelConnectionRecord>();
  private readonly seen = new Set<string>();
  private readonly mappings = new Map<string, ConversationMapping>();
  private readonly receipts = new Map<string, DeliveryReceipt>();

  async upsertConnection(connection: ChannelConnectionRecord): Promise<void> {
    this.connections.set(connection.connectionId, connection);
  }

  async getConnection(connectionId: string): Promise<ChannelConnectionRecord | undefined> {
    return this.connections.get(connectionId);
  }

  async listConnections(orgId: string): Promise<ChannelConnectionRecord[]> {
    return [...this.connections.values()].filter((c) => c.orgId === orgId);
  }

  async setStatus(connectionId: string, status: "active" | "paused" | "error"): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (conn) conn.status = status;
  }

  /** Returns false when the message was already processed (dedupe). */
  async seenMessage(connectionId: string, externalMessageId: string): Promise<boolean> {
    const key = `${connectionId}:${externalMessageId}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private mappingKey(connectionId: string, externalConversationId: string): string {
    return `${connectionId}:${externalConversationId}`;
  }

  async getMapping(connectionId: string, externalConversationId: string): Promise<ConversationMapping | undefined> {
    return this.mappings.get(this.mappingKey(connectionId, externalConversationId));
  }

  async putMapping(mapping: ConversationMapping): Promise<void> {
    this.mappings.set(this.mappingKey(mapping.connectionId, mapping.externalConversationId), mapping);
  }

  async recordReceipt(receipt: DeliveryReceipt): Promise<DeliveryReceipt> {
    this.receipts.set(receipt.messageId, receipt);
    return receipt;
  }
}

/** Agent-side handler; the runtime supplies it in production wiring. */
export type AgentReplyHandler = (
  inbound: CanonicalInbound,
  threadId: string,
) => Promise<{ text: string; attachments?: CanonicalInbound["attachments"] }>;

export interface OutboundTransport {
  send(connection: ChannelConnectionRecord, payload: Record<string, unknown>): Promise<{ delivered: boolean; error?: string }>;
}

export class HttpOutboundTransport implements OutboundTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(
    connection: ChannelConnectionRecord,
    payload: Record<string, unknown>,
  ): Promise<{ delivered: boolean; error?: string }> {
    if (!connection.outboundUrl) return { delivered: false, error: "no_outbound_url" };
    try {
      const res = await this.fetchImpl(connection.outboundUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.ok ? { delivered: true } : { delivered: false, error: `HTTP ${res.status}` };
    } catch (error) {
      return { delivered: false, error: String(error) };
    }
  }
}

export interface InboundResult {
  accepted: boolean;
  reason?: "duplicate" | "bad_signature" | "unknown_connection" | "paused" | "missing_thread_fields";
  threadId?: string;
}

export class ChannelGateway {
  readonly store: ChannelStore;
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly transport: OutboundTransport;
  private replyHandler?: AgentReplyHandler;

  constructor(store: ChannelStore = new InMemoryChannelStore(), transport: OutboundTransport = new HttpOutboundTransport()) {
    this.store = store;
    this.transport = transport;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  adapter(kind: string): ChannelAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no channel adapter registered for ${kind}`);
    return adapter;
  }

  onReply(handler: AgentReplyHandler): void {
    this.replyHandler = handler;
  }

  /**
   * Attach a channel to an agent. An agent may attach to MANY channels and
   * a channel may be re-pointed later — nothing hard-codes one pair.
   */
  async attach(input: {
    connectionId: string;
    orgId: string;
    agentId: string;
    kind: string;
    secretRef: string;
    outboundUrl?: string;
  }): Promise<ChannelConnectionRecord> {
    this.adapter(input.kind); // validate the adapter exists
    const connection: ChannelConnectionRecord = {
      ...input,
      providerKind: input.kind,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    await this.store.upsertConnection(connection);
    return connection;
  }

  async disconnect(connectionId: string): Promise<void> {
    await this.store.setStatus(connectionId, "paused");
  }

  async reconnect(connectionId: string): Promise<void> {
    await this.store.setStatus(connectionId, "active");
  }

  /**
   * Full inbound pipeline with signature verification, idempotent dedupe,
   * external conversation → Mox thread mapping, agent dispatch and
   * best-effort outbound delivery with receipts.
   */
  async handleWebhook(input: {
    connectionId: string;
    headers: Record<string, string>;
    rawBody: string;
    secret: string;
  }): Promise<InboundResult> {
    const connection = await this.store.getConnection(input.connectionId);
    if (!connection) return { accepted: false, reason: "unknown_connection" };
    if (connection.status !== "active") return { accepted: false, reason: "paused" };

    const adapter = this.adapter(connection.providerKind);
    if (!adapter.verifyWebhook(input.headers, input.rawBody, input.secret).ok) {
      await this.store.setStatus(input.connectionId, "error");
      return { accepted: false, reason: "bad_signature" };
    }

    const inbound = adapter.normalize({ connectionId: input.connectionId, headers: input.headers, rawBody: input.rawBody });
    const fresh = await this.store.seenMessage(input.connectionId, inbound.externalMessageId);
    if (!fresh) return { accepted: false, reason: "duplicate" };

    let mapping = await this.store.getMapping(input.connectionId, inbound.externalConversationId);
    if (!mapping) {
      mapping = {
        connectionId: input.connectionId,
        externalConversationId: inbound.externalConversationId,
        threadId: `thr_${crypto.randomUUID()}`,
        externalParticipantId: inbound.externalUserId,
      };
      await this.store.putMapping(mapping);
    }

    let response: { text: string; attachments?: CanonicalInbound["attachments"] } = { text: "" };
    if (this.replyHandler) {
      try {
        response = await this.replyHandler(inbound, mapping.threadId);
      } catch {
        response = { text: "The agent could not process that message." };
      }
    }

    if (response.text && connection.outboundUrl !== undefined) {
      const payload = adapter.formatOutbound({
        externalConversationId: inbound.externalConversationId,
        replyToExternalId: inbound.replyToExternalId,
        text: response.text,
        attachments: response.attachments,
      } satisfies OutboundReply);
      const result = await this.transport.send(connection, payload);
      await this.store.recordReceipt({
        messageId: inbound.externalMessageId,
        connectionId: input.connectionId,
        externalConversationId: inbound.externalConversationId,
        state: result.delivered ? "sent" : "failed",
        attempts: 1,
        error: result.error,
        at: new Date().toISOString(),
      });
    }
    return { accepted: true, threadId: mapping.threadId };
  }
}
