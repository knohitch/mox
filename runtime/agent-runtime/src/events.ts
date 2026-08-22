import { randomUUID } from "node:crypto";
import { AgentEvent as AgentEventSchema, type AgentEvent } from "@mox/contracts";

/**
 * Pre-validation event draft. Engines produce these with plain strings and
 * unknown payloads; `makeAgentEvent` is the single point that mints ids and
 * validates against the canonical AgentEvent contract. Keeping the draft
 * loose is deliberate: branded types apply after validation, not before.
 */
export type AgentEventInput = { type: string; at?: string } & Record<string, unknown>;

export function makeAgentEvent(agentId: string, input: AgentEventInput): AgentEvent {
  const { at, ...rest } = input as Record<string, unknown> & { at?: string };
  return AgentEventSchema.parse({
    ...rest,
    eventId: randomUUID(),
    agentId,
    at: at ?? new Date().toISOString(),
  });
}
