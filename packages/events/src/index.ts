import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CorrelationId, CausationId, EventId, IsoDateTime, JsonValue, Scope } from "@mox/contracts";

/**
 * Canonical event envelope. Every Mox event — agent events, audit events,
 * usage events, integration webhooks — is carried in this envelope so that
 * causation chains and tenancy scope are uniform across the platform.
 */

export const AuditMetadata = z.object({
  actor: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
    z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }),
    z.object({ kind: z.literal("system") }),
  ]),
  reason: z.string().optional(),
  complianceTags: z.array(z.string()).optional(),
});
export type AuditMetadata = z.infer<typeof AuditMetadata>;

/** Build a validated envelope schema for a given payload schema. */
export function envelopeSchema<P extends z.ZodType>(payload: P) {
  return z.object({
    eventId: EventId,
    type: z.string().min(1),
    version: z.number().int().positive(),
    scope: Scope,
    correlationId: CorrelationId.optional(),
    causationId: CausationId.optional(),
    at: IsoDateTime,
    payload,
    audit: AuditMetadata.optional(),
  });
}

export type Envelope<P> = {
  eventId: string;
  type: string;
  version: number;
  scope: Scope;
  correlationId?: string;
  causationId?: string;
  at: string;
  payload: P;
  audit?: AuditMetadata;
};

/** Create an envelope, generating eventId/correlationId/at when not supplied. */
export function createEnvelope<P extends JsonValue>(input: {
  type: string;
  version: number;
  scope: Scope;
  correlationId?: string;
  causationId?: string;
  at?: string;
  payload: P;
  audit?: AuditMetadata;
}): Envelope<P> {
  return {
    eventId: randomUUID(),
    type: input.type,
    version: input.version,
    scope: input.scope,
    correlationId: input.correlationId ?? randomUUID(),
    causationId: input.causationId,
    at: input.at ?? new Date().toISOString(),
    payload: input.payload,
    audit: input.audit,
  };
}