/**
 * Mox Node (Prompt 09): the agent that runs on the customer VPS.
 *
 * Trust model: the customer has root and may disable or modify this agent.
 * The Control Plane therefore treats everything Mox Node reports as
 * advisory. Mox Node can manage Docker workloads, stream status and execute
 * signed commands — it can never grant itself entitlements.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { scrubLogLine } from "@mox/security";

export const MOX_NODE_VERSION = "0.1.0";

export const MOX_NODE_CAPABILITIES = [
  "docker",
  "logs",
  "metrics",
  "backups",
  "updates",
] as const;

export type MoxNodeCapability = (typeof MOX_NODE_CAPABILITIES)[number];

export interface EnrollRequest {
  enrollToken: string;
  nodeId: string;
  version: string;
  capabilities: readonly string[];
}

export interface EnrollResponse {
  nodeId: string;
  orgId: string;
  orderId?: string;
  /** Bearer token for heartbeat/command channels; rotate via control plane. */
  agentToken: string;
}

export interface NodeMetrics {
  cpuPct?: number;
  memUsedMb?: number;
  memTotalMb?: number;
  diskUsedGb?: number;
  diskTotalGb?: number;
  load1?: number;
}

// ---- Signed command channel -------------------------------------------------

export type NodeCommandKind =
  | "deployment.apply"
  | "workload.restart"
  | "workload.stop"
  | "node.update"
  | "backup.run";

export interface SignedCommand {
  nonce: string;
  kind: NodeCommandKind;
  payload: Record<string, unknown>;
  issuedAt: string;
  signature: string;
}

const COMMAND_STALENESS_MS = 5 * 60_000;

export function signCommand(secret: string, cmd: Omit<SignedCommand, "signature">): SignedCommand {
  const signature = createHmac("sha256", secret)
    .update(`${cmd.nonce}.${cmd.kind}.${cmd.issuedAt}.${JSON.stringify(cmd.payload)}`)
    .digest("hex");
  return { ...cmd, signature };
}

/** Replay-protected verifier; nonces are single-use for their TTL window. */
export class CommandVerifier {
  private readonly seen = new Map<string, number>();

  verify(secret: string, cmd: SignedCommand, nowMs = Date.now()): { ok: boolean; reason?: string } {
    const expected = signCommand(
      secret,
      { nonce: cmd.nonce, kind: cmd.kind, issuedAt: cmd.issuedAt, payload: cmd.payload },
    ).signature;
    const a = Buffer.from(expected);
    const b = Buffer.from(cmd.signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "signature_mismatch" };
    }
    const age = nowMs - Date.parse(cmd.issuedAt);
    if (!Number.isFinite(age) || Math.abs(age) > COMMAND_STALENESS_MS) {
      return { ok: false, reason: "stale_timestamp" };
    }
    // Expire old nonces then enforce single use.
    for (const [nonce, at] of this.seen) {
      if (nowMs - at > COMMAND_STALENESS_MS) this.seen.delete(nonce);
    }
    if (this.seen.has(cmd.nonce)) {
      return { ok: false, reason: "replayed_nonce" };
    }
    this.seen.set(cmd.nonce, nowMs);
    return { ok: true };
  }
}

// ---- Workload management ------------------------------------------------------

export interface WorkloadSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  /** Secret references are resolved by the node's local vault mount. */
  secretMounts?: Array<{ hostPath: string; containerPath: string }>;
  ports?: Array<{ host: number; container: number }>;
  volumes?: Array<{ hostPath: string; containerPath: string }>;
  restartPolicy: "no" | "on-failure" | "always";
  cpus?: number;
  memoryMb?: number;
}

export interface ContainerState {
  name: string;
  running: boolean;
  image: string;
  startedAt?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function scrubStderr(stderr: string, maxBytes = 4096): string {
  const scrubbed = scrubLogLine(stderr);
  const buf = Buffer.from(scrubbed, "utf8");
  if (buf.byteLength <= maxBytes) return scrubbed;
  return `${buf.subarray(0, maxBytes).toString("utf8")}[truncated]`;
}

/** Thin executor seam so tests never need real Docker. */
export type CommandExecutor = (args: string[]) => Promise<CommandResult>;

export class DockerWorkloadManager {
  constructor(private readonly exec: CommandExecutor) {}

  async listRunning(): Promise<ContainerState[]> {
    const res = await this.exec(["ps", "--format", "{{json .}}"]);
    if (res.exitCode !== 0) throw new Error(`docker ps failed: ${scrubStderr(res.stderr)}`);
    const states: ContainerState[] = [];
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { Names?: string; Image?: string; RunningFor?: string };
      states.push({ name: row.Names ?? "", image: row.Image ?? "", running: true, startedAt: row.RunningFor });
    }
    return states;
  }

  async apply(spec: WorkloadSpec): Promise<void> {
    const existing = await this.inspect(spec.name);
    if (existing) {
      await this.exec(["rm", "-f", spec.name]);
    }
    const args = ["run", "-d", "--name", spec.name, `--restart=${spec.restartPolicy}`];
    for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
    for (const p of spec.ports ?? []) args.push("-p", `${p.host}:${p.container}`);
    for (const v of spec.volumes ?? []) args.push("-v", `${v.hostPath}:${v.containerPath}`);
    for (const s of spec.secretMounts ?? []) args.push("-v", `${s.hostPath}:${s.containerPath}:ro`);
    if (spec.cpus) args.push("--cpus", String(spec.cpus));
    if (spec.memoryMb) args.push("--memory", `${spec.memoryMb}m`);
    args.push(spec.image);
    const res = await this.exec(args);
    if (res.exitCode !== 0) throw new Error(`docker run failed: ${scrubStderr(res.stderr)}`);
  }

  async stop(name: string): Promise<void> {
    await this.exec(["rm", "-f", name]);
  }

  async logs(name: string, tailLines: number): Promise<string> {
    const res = await this.exec(["logs", "--tail", String(tailLines), name]);
    if (res.exitCode !== 0) throw new Error(`docker logs failed: ${scrubStderr(res.stderr)}`);
    return res.stdout;
  }

  private async inspect(name: string): Promise<boolean> {
    const res = await this.exec(["inspect", name]);
    return res.exitCode === 0;
  }
}
