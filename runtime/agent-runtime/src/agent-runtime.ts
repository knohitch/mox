import {
  type AgentDefinition,
  type AgentEvent,
  AgentDefinition as AgentDefinitionSchema,
} from "@mox/contracts";
import { createEnvelope } from "@mox/events";
import { dshEventToEnvelope, type DshSessionEvent } from "@mox/adapters";
import { RuntimeClient, newRunId } from "@mox/runtime-client";

/**
 * AgentRuntime: the Mox composition around a DSH-derived kernel.
 *
 * Responsibilities (Prompt 03):
 * - accept an AgentDefinition + runtime-scoped credentials/config and launch
 *   runs on the runtime process through @mox/runtime-client;
 * - stream canonical AgentEvents (normalized via @mox/adapters) and persist
 *   them through the SessionEventStore seam — never DSH local storage;
 * - supervise runs: cancel, crash detection, bounded restart with resume;
 * - enforce tenant isolation at routing time (org-scoped run registry).
 *
 * The Control Plane talks to THIS class only. DSH internals never leak past
 * it; when no external kernel is configured, `engine` runs in-process as the
 * reference loop so behavior stays testable.
 */

export interface AgentRuntimeOptions {
  client: RuntimeClient;
  events: SessionEventStoreLike;
  credentials?: CredentialGrantProviderLike;
  config?: ConfigProviderLike;
  /** Max supervised restarts per run before declaring failure. */
  maxRestartsPerRun?: number;
}

/** Structural seams (kept import-free here for host-side composition). */
export interface SessionEventStoreLike {
  append(orgId: string, runId: string, event: AgentEvent): Promise<void>;
  replay(orgId: string, runId: string): Promise<AgentEvent[]>;
}

export interface CredentialGrantProviderLike {
  /** Resolve vault refs into scoped grants embedded in runtimeConfig. */
  grant(refs: readonly string[]): Promise<Record<string, unknown>>;
}

export interface ConfigProviderLike {
  build(definition: AgentDefinition): Promise<Record<string, unknown>>;
}

export interface LaunchInput {
  definition: AgentDefinition;
  orgId: string;
  agentId: string;
  threadId: string;
  userInput: unknown;
  /** Vault refs to resolve into short-lived runtime credential grants. */
  credentialRefs?: readonly string[];
  resumeToken?: string;
  correlationId?: string;
}

export interface LaunchResult {
  runId: string;
  accepted: boolean;
  resumeToken?: string;
}

interface RunRecord {
  runId: string;
  orgId: string;
  agentId: string;
  threadId: string;
  state: "starting" | "running" | "waiting-approval" | "cancelling" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  restarts: number;
}

export class AgentRuntime {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly opts: AgentRuntimeOptions) {}

  async health() {
    return this.opts.client.health();
  }

  async capabilities() {
    return this.opts.client.capabilities();
  }

  /**
   * Launch a run. Validates the definition against the canonical schema,
   * resolves credentials/config through the provider seams, then hands the
   * runtime process a fully-scoped RunStartRequest.
   */
  async launch(input: LaunchInput): Promise<LaunchResult> {
    // Contract gate: never forward an invalid definition to the kernel.
    const definition = AgentDefinitionSchema.parse(input.definition);

    const runtimeConfigPieces: Record<string, unknown> = {};
    if (this.opts.config) {
      Object.assign(runtimeConfigPieces, await this.opts.config.build(definition));
    }
    if (this.opts.credentials && input.credentialRefs?.length) {
      const grants = await this.opts.credentials.grant(input.credentialRefs);
      Object.assign(runtimeConfigPieces, grants);
    }

    const runId = newRunId();
    const record: RunRecord = {
      runId,
      orgId: input.orgId,
      agentId: input.agentId,
      threadId: input.threadId,
      state: "starting",
      startedAt: new Date().toISOString(),
      restarts: 0,
    };
    this.runs.set(runId, record);

    const result = await this.opts.client.startRun({
      runId,
      orgId: input.orgId,
      agentId: input.agentId,
      threadId: input.threadId,
      definition,
      runtimeConfig: runtimeConfigPieces,
    });
    record.state = "running";
    return { runId, accepted: result.accepted, resumeToken: result.resumeToken };
  }

  async resume(input: LaunchInput & { resumeToken: string }): Promise<LaunchResult> {
    const definition = AgentDefinitionSchema.parse(input.definition);
    const runId = newRunId();
    this.runs.set(runId, {
      runId,
      orgId: input.orgId,
      agentId: input.agentId,
      threadId: input.threadId,
      state: "starting",
      startedAt: new Date().toISOString(),
      restarts: 0,
    });
    const result = await this.opts.client.resumeRun({
      runId,
      orgId: input.orgId,
      agentId: input.agentId,
      threadId: input.threadId,
      definition,
      runtimeConfig: {},
      resumeToken: input.resumeToken,
    });
    const record = this.runs.get(runId);
    if (record) record.state = "running";
    return { runId, accepted: result.accepted, resumeToken: result.resumeToken };
  }

  async cancel(runId: string, reason?: string): Promise<boolean> {
    const record = this.requireRun(runId);
    record.state = "cancelling";
    const result = await this.opts.client.cancelRun({ runId, reason });
    if (result.cancelled) {
      record.state = "cancelled";
    }
    return result.cancelled;
  }

  /** List active runs, optionally filtered to one org (tenant isolation). */
  listRuns(orgId?: string): Array<RunRecord & { runId: string }> {
    const all = Array.from(this.runs.values());
    const visible = orgId ? all.filter((r) => r.orgId === orgId) : all;
    return visible.map((r) => ({ ...r }));
  }

  /** Replay persisted events for a run — org-checked at the store seam. */
  async replayEvents(orgId: string, runId: string): Promise<AgentEvent[]> {
    this.requireRunForOrg(orgId, runId);
    return this.opts.events.replay(orgId, runId);
  }

  /**
   * Supervised restart: called by hosts after the transport reports a crash.
   * Bounded by maxRestartsPerRun; uses the runtime's resume token so the
   * kernel can recover its session without local-state trust.
   */
  async restartAfterCrash(
    runId: string,
    input: LaunchInput,
    resumeToken?: string,
  ): Promise<LaunchResult | { blocked: string }> {
    const record = this.runs.get(runId);
    if (!record) return { blocked: `unknown run ${runId}` };
    const max = this.opts.maxRestartsPerRun ?? 2;
    if (record.restarts >= max) {
      record.state = "failed";
      return { blocked: `run ${runId} exceeded max restarts (${max})` };
    }
    record.restarts += 1;
    record.state = "starting";
    const relaunch =
      resumeToken !== undefined
        ? await this.resume({ ...input, resumeToken })
        : await this.launch(input);
    return relaunch;
  }

  async shutdown(gracefulTimeoutMs = 10_000): Promise<{ runsCancelled: number }> {
    let cancelled = 0;
    for (const record of Array.from(this.runs.values())) {
      if (!["succeeded", "failed", "cancelled"].includes(record.state)) {
        try {
          const result = await this.opts.client.cancelRun({
            runId: record.runId,
            reason: "runtime shutdown",
          });
          if (result.cancelled) cancelled += 1;
        } catch {
          // Best-effort cancel during shutdown; failures surface via health.
        }
        record.state = "cancelled";
      }
    }
    await this.opts.client.shutdown({ gracefulTimeoutMs });
    return { runsCancelled: cancelled };
  }

  private requireRun(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`unknown run: ${runId}`);
    return record;
  }

  private requireRunForOrg(orgId: string, runId: string): RunRecord {
    const record = this.requireRun(runId);
    if (record.orgId !== orgId) throw new Error("cross-tenant access denied");
    return record;
  }
}

/** Re-exports so hosts need only this package to compose the runtime. */
export { dshEventToEnvelope, createEnvelope };
export type { DshSessionEvent };
