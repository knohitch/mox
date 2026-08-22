import type { AgentEvent } from "@mox/contracts";
import { redact } from "@mox/credentials";

/**
 * Persistence boundary (Prompt 03): DSH's local session/credential/settings
 * stores are never authoritative in hosted Mox. The runtime host persists
 * through these seams instead; a Postgres event store replaces the bridge
 * implementation in Prompt 06.
 */

/** Append-only sink for canonical agent events, scoped by org. */
export interface SessionEventStore {
  append(orgId: string, runId: string, event: AgentEvent): Promise<void>;
  /** Replay events for one run, oldest first. */
  replay(orgId: string, runId: string): Promise<AgentEvent[]>;
}

export class InMemorySessionEventStore implements SessionEventStore {
  private readonly byRun = new Map<string, { orgId: string; events: AgentEvent[] }>();

  async append(orgId: string, runId: string, event: AgentEvent): Promise<void> {
    let entry = this.byRun.get(runId);
    if (!entry) {
      entry = { orgId, events: [] };
      this.byRun.set(runId, entry);
    }
    if (entry.orgId !== orgId) {
      // A run belongs to exactly one org for its whole life.
      throw new Error(`run ${runId} is not owned by org ${orgId}`);
    }
    entry.events.push(event);
  }

  async replay(orgId: string, runId: string): Promise<AgentEvent[]> {
    const entry = this.byRun.get(runId);
    if (!entry) return [];
    if (entry.orgId !== orgId) return []; // cross-tenant read: deny by silence
    return [...entry.events];
  }
}

/**
 * Credential grant seam. The runtime host resolves vault references to
 * short-lived secret values just before launch; secrets never persist in
 * runtime config and never enter the event stream.
 */
export interface RuntimeCredentialProvider {
  /** Resolve a vault reference produced by the Control Plane. */
  resolve(vaultRef: string): Promise<string | undefined>;
}

/** In-memory provider backed by @mox/credentials' sealed store semantics. */
export class InMemoryRuntimeCredentialProvider implements RuntimeCredentialProvider {
  private readonly secrets = new Map<string, string>();

  constructor(seeds: Record<string, string> = {}) {
    for (const [ref, secret] of Object.entries(seeds)) this.secrets.set(ref, secret);
  }

  async resolve(vaultRef: string): Promise<string | undefined> {
    return this.secrets.get(vaultRef);
  }
}

/** Runtime configuration seam: model routing, tool endpoints, feature flags. */
export interface RuntimeConfigProvider {
  /** Assemble non-secret runtime config for a definition launch. */
  build(definition: unknown): Promise<Record<string, unknown>>;
}

export class StaticRuntimeConfigProvider implements RuntimeConfigProvider {
  constructor(private readonly base: Record<string, unknown> = {}) {}

  async build(definition: unknown): Promise<Record<string, unknown>> {
    return {
      ...this.base,
      agent: definition instanceof Object ? { agentId: (definition as { agentId?: string }).agentId } : {},
    };
  }
}

/**
 * Redact an event before durable persistence: tool inputs/outputs and error
 * payloads may carry material that must not land in storage verbatim.
 * Uses the shared @mox/credentials redactor.
 */
export function redactForStorage(event: AgentEvent): AgentEvent {
  const clone = structuredClone(event) as Record<string, unknown>;
  for (const key of ["input", "output", "error"]) {
    if (key in clone && typeof clone[key] === "object" && clone[key] !== null) {
      clone[key] = redact(clone[key]);
    }
  }
  return event.constructor === Object ? (clone as AgentEvent) : event;
}
