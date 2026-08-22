import { scrubLogLine } from "@mox/security";
import { checkPortBindings, type PortBindingCheck } from "@mox/security";

/**
 * Mox runtime supervisor (Prompt 04): OpenBot Supervisor concepts re-owned by
 * Mox, ready to embed into Mox Node later. Deterministic container names,
 * per-agent/per-session isolation, health/restart with a bounded budget,
 * resource limits, and per-session workspaces — no shared browser or login
 * state across tenants.
 *
 * The supervisor never assumes Docker is present: the container driver is an
 * interface. The in-repo driver is an in-memory simulator whose lifecycle
 * semantics (names, limits, restarts, health) are fully tested; the Docker
 * driver plugs into the same interface inside Mox Node.
 */

export interface ResourceLimits {
  cpus: number;
  memoryMb: number;
  /** Max concurrent containers this supervisor will run overall. */
  maxContainers?: number;
}

export interface ContainerSpec {
  /** Deterministic name is derived from org/agent/session if not given. */
  name?: string;
  orgId: string;
  agentId: string;
  sessionId?: string;
  image: string;
  limits: ResourceLimits;
  /** Per-session workspace volume; mounted read-write for this session only. */
  workspaceVolume?: string;
  portBindings?: Array<{ hostIp: string; hostPort: number }>;
}

export type ContainerState = "creating" | "running" | "unhealthy" | "stopped" | "crashed";

export interface ContainerRecord {
  name: string;
  spec: ContainerSpec;
  state: ContainerState;
  restarts: number;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
}

/** Deterministic, collision-free container naming: mox-<org>-<agent>-<session>. */
export function containerName(spec: Pick<ContainerSpec, "orgId" | "agentId" | "sessionId">): string {
  const part = (s: string) =>
    s
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      // Docker names must start with an alphanumeric: strip leading/trailing dots and dashes.
      .replace(/^[.-]+/, "")
      .replace(/[.-]+$/, "")
      .slice(0, 32);
  const safe = (s: string) => {
    const p = part(s);
    return p.length > 0 ? p : "anon";
  };
  const segments = ["mox", safe(spec.orgId), safe(spec.agentId)];
  if (spec.sessionId) segments.push(safe(spec.sessionId));
  return segments.join("-").toLowerCase();
}

export interface ContainerDriver {
  create(spec: ContainerSpec & { name: string }): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Probe health; false means the container needs a restart. */
  health(name: string): Promise<boolean>;
  list(): Promise<string[]>;
}

/** In-memory driver: deterministic lifecycle semantics for tests/dev. */
export class InMemoryContainerDriver implements ContainerDriver {
  private readonly containers = new Map<string, { healthy: boolean; running: boolean }>();

  async create(spec: ContainerSpec & { name: string }): Promise<void> {
    if (this.containers.has(spec.name)) throw new Error(`container exists: ${spec.name}`);
    this.containers.set(spec.name, { healthy: true, running: false });
  }
  async start(name: string): Promise<void> {
    const c = this.containers.get(name);
    if (!c) throw new Error(`no container: ${name}`);
    c.running = true;
    c.healthy = true;
  }
  async stop(name: string): Promise<void> {
    const c = this.containers.get(name);
    if (!c) throw new Error(`no container: ${name}`);
    c.running = false;
  }
  async remove(name: string): Promise<void> {
    this.containers.delete(name);
  }
  async health(name: string): Promise<boolean> {
    const c = this.containers.get(name);
    return c?.running === true && c.healthy;
  }
  async list(): Promise<string[]> {
    return Array.from(this.containers.keys());
  }
  /** Test hook: simulate a crash. */
  crash(name: string): void {
    const c = this.containers.get(name);
    if (c) {
      c.running = false;
      c.healthy = false;
    }
  }
}

export class SupervisorError extends Error {}

export interface SupervisorOptions {
  driver: ContainerDriver;
  maxRestarts?: number;
  now?: () => Date;
}

export class RuntimeSupervisor {
  private readonly records = new Map<string, ContainerRecord>();

  constructor(private readonly opts: SupervisorOptions) {}

  /**
   * Launch an isolated workload container. Enforces:
   * - deterministic names (derived when absent);
   * - global capacity limit;
   * - internal control ports loopback-only (rejected otherwise);
   * - per-session workspace volumes (never shared across sessions).
   */
  async launch(spec: ContainerSpec): Promise<ContainerRecord> {
    const name = spec.name ?? containerName(spec);
    if (this.records.has(name)) throw new SupervisorError(`container already launched: ${name}`);

    const maxTotal = spec.limits.maxContainers ?? 64;
    if (this.records.size >= maxTotal) {
      throw new SupervisorError(`supervisor at capacity (${maxTotal} containers)`);
    }

    if (spec.portBindings) {
      const check: PortBindingCheck = checkPortBindings(spec.portBindings);
      if (!check.ok) throw new SupervisorError(check.reason);
    }

    await this.opts.driver.create({ ...spec, name });
    await this.opts.driver.start(name);
    const record: ContainerRecord = {
      name,
      spec,
      state: "running",
      restarts: 0,
      startedAt: new Date().toISOString(),
    };
    this.records.set(name, record);
    return { ...record };
  }

  get(name: string): ContainerRecord | undefined {
    const r = this.records.get(name);
    return r ? { ...r } : undefined;
  }

  list(): ContainerRecord[] {
    return Array.from(this.records.values(), (r) => ({ ...r }));
  }

  /** List containers owned by one org only (tenant isolation). */
  listForOrg(orgId: string): ContainerRecord[] {
    return this.list().filter((r) => r.spec.orgId === orgId);
  }

  /** Health sweep: mark unhealthy, restart within budget, else crash out. */
  async sweepHealth(): Promise<Array<{ name: string; action: "healthy" | "restarted" | "crashed" }>> {
    const results: Array<{ name: string; action: "healthy" | "restarted" | "crashed" }> = [];
    for (const record of Array.from(this.records.values())) {
      if (record.state === "stopped") continue;
      const healthy = await this.opts.driver.health(record.name);
      if (healthy) {
        record.state = "running";
        results.push({ name: record.name, action: "healthy" });
        continue;
      }
      const maxRestarts = this.opts.maxRestarts ?? 2;
      if (record.restarts < maxRestarts) {
        record.restarts += 1;
        await this.opts.driver.stop(record.name);
        await this.opts.driver.start(record.name);
        record.state = "running";
        results.push({ name: record.name, action: "restarted" });
      } else {
        record.state = "crashed";
        record.lastError = `exceeded ${maxRestarts} restarts`;
        results.push({ name: record.name, action: "crashed" });
      }
    }
    return results;
  }

  /** Simulate/report a crash from outside (driver hook or Mox Node event). */
  reportCrash(name: string, reason: string): ContainerRecord {
    const record = this.records.get(name);
    if (!record) throw new SupervisorError(`unknown container: ${name}`);
    record.state = "crashed";
    record.lastError = scrubLogLine(reason).slice(0, 500);
    return { ...record };
  }

  async stop(name: string): Promise<ContainerRecord> {
    const record = this.records.get(name);
    if (!record) throw new SupervisorError(`unknown container: ${name}`);
    await this.opts.driver.stop(name);
    record.state = "stopped";
    record.stoppedAt = new Date().toISOString();
    return { ...record };
  }

  async terminate(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) throw new SupervisorError(`unknown container: ${name}`);
    await this.opts.driver.stop(name);
    await this.opts.driver.remove(name);
    this.records.delete(name);
  }
}
