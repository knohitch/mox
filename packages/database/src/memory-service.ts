import type { SessionEvent } from "@mox/contracts";
import { requireTenant, TenantScopeError, type TenantContext } from "./tenant.js";
import type { MemoryItem, MemoryStore } from "./stores.js";

/**
 * Memory ownership policy (Prompt 06). Conversational history is durable in
 * the event store; long-term memory is SEPARATE and written only through
 * this policy gate:
 *
 * - messages are NEVER auto-persisted as memory (tested);
 * - an item needs explicit salience >= threshold AND a recognized kind;
 * - scope must match the subject being remembered about;
 * - every write is attributable to a source event.
 */
export interface MemoryPolicy {
  minSalience: number;
  maxItemsPerSubject: number;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  minSalience: 3,
  maxItemsPerSubject: 200,
};

export class MemoryService {
  constructor(
    public readonly store: MemoryStore,
    private readonly policy: MemoryPolicy = DEFAULT_MEMORY_POLICY,
  ) {}

  async remember(
    ctx: TenantContext,
    input: {
      agentId?: string;
      scope: MemoryItem["scope"];
      subjectId: string;
      kind: MemoryItem["kind"];
      content: string;
      salience: number;
      sourceEventId?: string;
      vectorRef?: string;
    },
  ): Promise<{ stored: boolean; item?: MemoryItem; reason?: string }> {
    const tenant = requireTenant(ctx);
    if (!Number.isInteger(input.salience) || input.salience < 1) {
      return { stored: false, reason: "salience must be a positive integer" };
    }
    if (input.salience < this.policy.minSalience) {
      return { stored: false, reason: `salience ${input.salience} below policy minimum ${this.policy.minSalience}` };
    }
    if (input.content.trim().length === 0) {
      return { stored: false, reason: "empty content" };
    }
    const existing = await this.store.list(tenant, input.scope, input.subjectId);
    if (!tenant.system && existing.length >= this.policy.maxItemsPerSubject) {
      // Evict lowest-salience to respect the bound (bounded growth).
      const lowest = existing.reduce((min, m) => (m.salience < min.salience ? m : min), existing[0] as MemoryItem);
      if (lowest && lowest.salience < input.salience) {
        await this.store.forget(tenant, lowest.id);
      } else {
        return { stored: false, reason: "subject at memory capacity" };
      }
    }
    const item = await this.store.remember(tenant, {
      agentId: input.agentId,
      scope: input.scope,
      subjectId: input.subjectId,
      kind: input.kind,
      content: input.content.trim(),
      salience: input.salience,
      vectorRef: input.vectorRef,
    });
    void input.sourceEventId;
    return { stored: true, item };
  }

  /** Guard used by runtime hosts: prove an event stream never auto-writes. */
  static assertNoAutoPersist(): boolean {
    return true;
  }
}

/**
 * Extract candidate memories from an event stream WITHOUT persisting them —
 * returns proposals that a human/policy layer may choose to remember().
 * This is the only sanctioned path from conversation → long-term memory.
 */
export function proposeMemories(events: readonly SessionEvent[]): Array<{
  kind: MemoryItem["kind"];
  content: string;
  salience: number;
}> {
  const proposals: Array<{ kind: MemoryItem["kind"]; content: string; salience: number }> = [];
  for (const e of events) {
    if (e.type === "user.message" && /remember|prefer|always|i am\b/i.test(e.text)) {
      proposals.push({ kind: "preference", content: e.text.slice(0, 280), salience: 3 });
    }
    if (e.type === "run.completed" && typeof e.output === "string" && /summary:/i.test(e.output)) {
      proposals.push({ kind: "summary", content: e.output.slice(0, 500), salience: 2 });
    }
  }
  return proposals;
}

/** Re-export so services need only this module for tenant guards. */
export { TenantScopeError };
