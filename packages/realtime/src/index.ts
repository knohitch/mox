import { randomUUID } from "node:crypto";
import { OrgId } from "@mox/contracts";
import { createEnvelope, type Envelope } from "@mox/events";

/**
 * Mox Realtime (Prompt 06): a transport-agnostic pub/sub abstraction.
 *
 * The web UI consumes topics + canonical envelopes only — never
 * Supabase-specific shapes. Today the in-repo transport is an in-process bus;
 * a WebSocket/SSE server or Supabase Broadcast adapter implements the same
 * `RealtimeTransport` seam for hosted deployments.
 */

export type RealtimeTopic =
  | `thread:${string}:${string}` // orgId:threadId — streaming deltas, tool events
  | `presence:${string}` // orgId — agent online/working status
  | `server:${string}:${string}` // orgId:serverId — provisioning progress
  | `deployment:${string}:${string}` // orgId:deploymentId — deploy progress
  | `approvals:${string}` // orgId — open approval requests
  | `notifications:${string}:${string}`; // orgId:userId

export interface PublishInput {
  topic: RealtimeTopic;
  correlationId?: string;
  causationId?: string;
  payload: unknown;
}

export interface Subscription {
  unsubscribe(): void;
}

/** The seam a concrete transport (WS/SSE/Supabase Broadcast) implements. */
export interface RealtimeTransport {
  publish(input: PublishInput): Promise<Envelope<unknown>>;
  subscribe(
    topic: RealtimeTopic,
    handler: (envelope: Envelope<unknown>) => void,
    subscriber: { orgId: string },
  ): Subscription;
}

export class InMemoryRealtimeBus implements RealtimeTransport {
  private readonly subs = new Map<string, Set<{ handler: (e: Envelope<unknown>) => void; orgId: string }>>();

  async publish(input: PublishInput): Promise<Envelope<unknown>> {
    const orgId = orgFromTopic(input.topic);
    const envelope = createEnvelope({
      type: "realtime.message",
      version: 1,
      scope: { orgId: OrgId.safeParse(orgId).success ? OrgId.parse(orgId) : undefined },
      correlationId: input.correlationId,
      causationId: input.causationId,
      payload: input.payload as never,
    });
    await this.publishEnvelope(input.topic, envelope);
    return envelope;
  }

  async publishEnvelope(topic: RealtimeTopic, envelope: Envelope<unknown>): Promise<void> {
    const set = this.subs.get(topic);
    if (!set) return;
    for (const sub of Array.from(set)) {
      // Tenant isolation at delivery time: a subscriber never receives
      // envelopes from another organization's topic.
      if (!envelope.scope.orgId || envelope.scope.orgId === sub.orgId) {
        try {
          sub.handler(envelope);
        } catch {
          // A failing subscriber must not break fanout to others.
        }
      }
    }
  }

  subscribe(
    topic: RealtimeTopic,
    handler: (envelope: Envelope<unknown>) => void,
    subscriber: { orgId: string },
  ): Subscription {
    const entry = { handler, orgId: subscriber.orgId };
    const set = this.subs.get(topic) ?? new Set();
    set.add(entry);
    this.subs.set(topic, set);
    return {
      unsubscribe: () => {
        const current = this.subs.get(topic);
        if (!current) return;
        current.delete(entry);
        if (current.size === 0) this.subs.delete(topic);
      },
    };
  }
}

function orgFromTopic(topic: RealtimeTopic): string {
  // Every topic embeds orgId as its first variable segment.
  return topic.split(":")[1] ?? "";
}

export function newRealtimeCorrelationId(): string {
  return randomUUID();
}
