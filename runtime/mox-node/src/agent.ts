/**
 * Mox Node agent loop: enrollment, heartbeat and signed-command polling
 * over an outbound-only HTTPS channel to the Control Plane.
 */

import type { CommandExecutor, EnrollRequest, EnrollResponse, NodeMetrics, SignedCommand, WorkloadSpec } from "./core.js";
import { DockerWorkloadManager, MOX_NODE_CAPABILITIES, MOX_NODE_VERSION, scrubStderr } from "./core.js";

export interface MoxNodeConfig {
  controlPlaneUrl: string;
  /** Path to the local enroll.env written by cloud-init. */
  envFile?: string;
}

export interface NodeIdentity {
  nodeId: string;
  orgId: string;
  agentToken: string;
}

export interface ControlPlaneClient {
  enroll(request: EnrollRequest): Promise<EnrollResponse>;
  heartbeat(identity: NodeIdentity, metrics: NodeMetrics): Promise<void>;
  pollCommands(identity: NodeIdentity): Promise<SignedCommand[]>;
  ackCommand(identity: NodeIdentity, nonce: string, ok: boolean, detail?: string): Promise<void>;
}

export class HttpControlPlaneClient implements ControlPlaneClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) throw new Error(`control plane ${path} failed (${res.status})`);
    return (await res.json()) as T;
  }

  enroll(request: EnrollRequest): Promise<EnrollResponse> {
    return this.call<EnrollResponse>("/node/enroll", { method: "POST", body: JSON.stringify(request) }, request.enrollToken);
  }

  heartbeat(identity: NodeIdentity, metrics: NodeMetrics): Promise<void> {
    return this.call<void>(
      `/node/${encodeURIComponent(identity.nodeId)}/heartbeat`,
      { method: "POST", body: JSON.stringify({ metrics }) },
      identity.agentToken,
    );
  }

  pollCommands(identity: NodeIdentity): Promise<SignedCommand[]> {
    return this.call<SignedCommand[]>(`/node/${encodeURIComponent(identity.nodeId)}/commands`, {}, identity.agentToken);
  }

  ackCommand(identity: NodeIdentity, nonce: string, ok: boolean, detail?: string): Promise<void> {
    return this.call<void>(
      `/node/${encodeURIComponent(identity.nodeId)}/ack`,
      { method: "POST", body: JSON.stringify({ nonce, ok, detail }) },
      identity.agentToken,
    );
  }
}

export interface MoxNodeStateStore {
  getIdentity(): NodeIdentity | undefined;
  setIdentity(identity: NodeIdentity): void;
}

export class InMemoryNodeState implements MoxNodeStateStore {
  private identity?: NodeIdentity;
  getIdentity(): NodeIdentity | undefined {
    return this.identity;
  }
  setIdentity(identity: NodeIdentity): void {
    this.identity = identity;
  }
}

export interface MoxNodeOptions {
  version?: string;
  capabilities?: readonly string[];
  /** HMAC secret used to verify control-plane command signatures. */
  commandSecret: string;
}

export class MoxNodeAgent {
  readonly workloads: DockerWorkloadManager;
  private readonly client: ControlPlaneClient;
  private readonly state: MoxNodeStateStore;
  private readonly exec: CommandExecutor;
  private readonly options: MoxNodeOptions;

  constructor(
    client: ControlPlaneClient,
    state: MoxNodeStateStore,
    exec: CommandExecutor,
    options: MoxNodeOptions,
  ) {
    this.client = client;
    this.state = state;
    this.exec = exec;
    this.options = options;
    this.workloads = new DockerWorkloadManager(exec);
  }

  get identity(): NodeIdentity | undefined {
    return this.state.getIdentity();
  }

  /** Exchange the one-time cloud-init token for a rotating agent token. */
  async enroll(enrollToken: string, nodeId: string): Promise<NodeIdentity> {
    const response = await this.client.enroll({
      enrollToken,
      nodeId,
      version: this.options.version ?? MOX_NODE_VERSION,
      capabilities: this.options.capabilities ?? MOX_NODE_CAPABILITIES,
    });
    const identity: NodeIdentity = {
      nodeId: response.nodeId,
      orgId: response.orgId,
      agentToken: response.agentToken,
    };
    this.state.setIdentity(identity);
    return identity;
  }

  async sendHeartbeat(metrics: NodeMetrics): Promise<void> {
    const identity = this.requireIdentity();
    await this.client.heartbeat(identity, metrics);
  }

  /** Verify + apply one batch of signed commands; ack each outcome. */
  async processCommands(verifyFn: (cmd: SignedCommand) => { ok: boolean; reason?: string }): Promise<string[]> {
    const identity = this.requireIdentity();
    const applied: string[] = [];
    for (const cmd of await this.client.pollCommands(identity)) {
      const verdict = verifyFn(cmd);
      if (!verdict.ok) {
        await this.client.ackCommand(identity, cmd.nonce, false, verdict.reason);
        continue;
      }
      try {
        await this.applyCommand(cmd);
        applied.push(cmd.nonce);
        await this.client.ackCommand(identity, cmd.nonce, true);
      } catch (error) {
        await this.client.ackCommand(identity, cmd.nonce, false, String(error));
      }
    }
    return applied;
  }

  private async applyCommand(cmd: SignedCommand): Promise<void> {
    switch (cmd.kind) {
      case "deployment.apply": {
        const spec = cmd.payload.spec as WorkloadSpec | undefined;
        if (!spec?.name || !spec.image) throw new Error("deployment.apply requires spec.name and spec.image");
        await this.workloads.apply(spec);
        break;
      }
      case "workload.restart": {
        const spec = cmd.payload.spec as WorkloadSpec | undefined;
        if (!spec?.name) throw new Error("workload.restart requires spec");
        await this.workloads.apply(spec);
        break;
      }
      case "workload.stop": {
        const name = cmd.payload.name as string | undefined;
        if (!name) throw new Error("workload.stop requires name");
        await this.workloads.stop(name);
        break;
      }
      case "node.update": {
        // Update flow re-executes the installer; out of scope for unit path.
        break;
      }
      case "backup.run": {
        const paths = (cmd.payload.paths as string[] | undefined) ?? [];
        const res = await this.exec(["backup", ...paths]);
        if (res.exitCode !== 0) throw new Error(`backup failed: ${scrubStderr(res.stderr)}`);
        break;
      }
      default:
        throw new Error(`unsupported command kind ${(cmd as { kind: string }).kind}`);
    }
  }

  private requireIdentity(): NodeIdentity {
    const identity = this.identity;
    if (!identity) throw new Error("node is not enrolled");
    return identity;
  }
}
