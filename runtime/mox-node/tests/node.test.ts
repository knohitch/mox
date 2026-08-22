import { describe, expect, it } from "vitest";
import {
  CommandVerifier,
  DockerWorkloadManager,
  MOX_NODE_CAPABILITIES,
  MOX_NODE_VERSION,
  signCommand,
  type NodeMetrics,
  type SignedCommand,
} from "../src/core.js";
import { HttpControlPlaneClient, InMemoryNodeState, MoxNodeAgent } from "../src/agent.js";

describe("mox-node command channel", () => {
  it("verifies correctly signed commands", () => {
    const verifier = new CommandVerifier();
    const cmd = signCommand("s3cret", {
      nonce: "n-1",
      kind: "deployment.apply",
      payload: { spec: { name: "agent-x", image: "ghcr.io/mox/rt:1" } },
      issuedAt: new Date().toISOString(),
    });
    expect(verifier.verify("s3cret", cmd)).toEqual({ ok: true });
  });

  it("rejects tampered signatures", () => {
    const verifier = new CommandVerifier();
    const cmd = signCommand("s3cret", { nonce: "n-2", kind: "backup.run", payload: {}, issuedAt: new Date().toISOString() });
    const tampered: SignedCommand = { ...cmd, signature: "a".repeat(64) };
    const result = verifier.verify("s3cret", tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects stale timestamps to prevent replay of old commands", () => {
    const verifier = new CommandVerifier();
    const stale = signCommand("s3cret", {
      nonce: "n-3",
      kind: "workload.stop",
      payload: { name: "old" },
      issuedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    const result = verifier.verify("s3cret", stale);
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("enforces single-use nonces", () => {
    const verifier = new CommandVerifier();
    const cmd = signCommand("s3cret", { nonce: "n-4", kind: "node.update", payload: {}, issuedAt: new Date().toISOString() });
    expect(verifier.verify("s3cret", cmd).ok).toBe(true);
    const replay = verifier.verify("s3cret", cmd);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe("replayed_nonce");
  });
});

describe("docker workload manager", () => {
  function scripted(responses: Record<string, { stdout?: string; exitCode?: number; stderr?: string }>) {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      const key = args[0] ?? "";
      const r = responses[key] ?? { stdout: "", exitCode: 0 };
      return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    return { exec, calls };
  }

  it("applies workloads with env, ports, volumes and limits", async () => {
    const { exec, calls } = scripted({
      inspect: { exitCode: 1 },
    });
    const mgr = new DockerWorkloadManager(exec);
    await mgr.apply({
      name: "agent-a",
      image: "ghcr.io/mox/rt:2",
      env: { MOX_AGENT_ID: "a" },
      ports: [{ host: 8080, container: 8080 }],
      volumes: [{ hostPath: "/srv/data", containerPath: "/data" }],
      secretMounts: [{ hostPath: "/etc/mox-secrets/k", containerPath: "/run/secrets/k" }],
      restartPolicy: "on-failure",
      cpus: 1.5,
      memoryMb: 512,
    });
    const runArgs = calls.find((c) => c[0] === "run")!;
    expect(runArgs).toContain("--name");
    expect(runArgs).toContain("agent-a");
    expect(runArgs.join(" ")).toContain("-e MOX_AGENT_ID=a");
    expect(runArgs.join(" ")).toContain("-p 8080:8080");
    expect(runArgs.join(" ")).toContain("/etc/mox-secrets/k:/run/secrets/k:ro");
    expect(runArgs.join(" ")).toContain("--cpus 1.5");
    expect(runArgs.join(" ")).toContain("--memory 512m");
    // Old container was removed first (inspect said absent → no rm).
    expect(calls.filter((c) => c[0] === "rm")).toHaveLength(0);
  });

  it("replaces an existing container atomically on re-apply", async () => {
    const { exec, calls } = scripted({ inspect: { exitCode: 0 } });
    const mgr = new DockerWorkloadManager(exec);
    await mgr.apply({ name: "agent-b", image: "img:1", env: {}, restartPolicy: "always" });
    expect(calls.some((c) => c[0] === "rm")).toBe(true);
  });

  it("surfaces docker errors instead of faking success", async () => {
    const exec = async () => ({ exitCode: 125, stdout: "", stderr: "docker daemon down" });
    const mgr = new DockerWorkloadManager(exec);
    await expect(mgr.apply({ name: "x", image: "y", env: {}, restartPolicy: "no" })).rejects.toThrow(/daemon down/);
  });
});

describe("mox node agent loop", () => {
  function makeAgent() {
    const enrolled: Array<Record<string, unknown>> = [];
    const heartbeats: NodeMetrics[] = [];
    const acks: Array<{ nonce: string; ok: boolean; detail?: string }> = [];
    let commandsToReturn: SignedCommand[] = [];

    const client = {
      async enroll(request: { enrollToken: string; nodeId: string }) {
        enrolled.push(request);
        return { nodeId: request.nodeId, orgId: "org-9", agentToken: "atlas-token" };
      },
      async heartbeat(_id: unknown, metrics: NodeMetrics) {
        heartbeats.push(metrics);
        void heartbeats;
      },
      async pollCommands() {
        return commandsToReturn;
      },
      async ackCommand(_identity: unknown, nonce: string, ok: boolean, detail?: string) {
        acks.push({ nonce, ok, detail });
      },
    } as unknown as HttpControlPlaneClient;

    const executed: string[][] = [];
    const exec = async (args: string[]) => {
      executed.push(args);
      if (args[0] === "backup") return { exitCode: 0, stdout: "ok", stderr: "" };
      if (args[0] === "inspect") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const agent = new MoxNodeAgent(client, new InMemoryNodeState(), exec, { commandSecret: "shared-secret" });
    return {
      agent,
      client,
      enrolled,
      acks,
      executed,
      setCommands: (c: SignedCommand[]) => {
        commandsToReturn = c;
      },
    };
  }

  it("enrolls with one-time token and reports version/capabilities", async () => {
    const { agent, enrolled } = makeAgent();
    await agent.enroll("one-time", "node-xyz");
    expect(enrolled[0]).toMatchObject({ nodeId: "node-xyz", version: MOX_NODE_VERSION, capabilities: MOX_NODE_CAPABILITIES });
    expect(agent.identity?.agentToken).toBe("atlas-token");
  });

  it("applies signed deployment commands and stops unsigned ones", async () => {
    const { agent, setCommands, acks, executed } = makeAgent();
    await agent.enroll("one-time", "node-abc");

    const good = signCommand("shared-secret", {
      nonce: "ok-1",
      kind: "deployment.apply",
      payload: { spec: { name: "agent-1", image: "rt:1", env: {}, restartPolicy: "always" } },
      issuedAt: new Date().toISOString(),
    });
    const bad = signCommand("wrong-secret", {
      nonce: "bad-1",
      kind: "workload.stop",
      payload: { name: "agent-1" },
      issuedAt: new Date().toISOString(),
    });
    setCommands([good, bad]);

    const applied = await agent.processCommands((cmd) =>
      new CommandVerifier().verify(cmd.signature === bad.signature ? "never" : "shared-secret", cmd),
    );
    // Verifier seam decides; here we verify the agent honors verdicts + acks.
    void applied;
    expect(acks.map((a) => a.nonce).sort()).toEqual(["bad-1", "ok-1"]);
    expect(acks.find((a) => a.nonce === "bad-1")?.ok).toBe(false);
    expect(executed.some((args) => args.includes("agent-1"))).toBe(true);
  });

  it("runs backup commands via the local executor", async () => {
    const { agent, setCommands, executed } = makeAgent();
    await agent.enroll("one-time", "node-bk");
    const cmd = signCommand("shared-secret", {
      nonce: "bk-1",
      kind: "backup.run",
      payload: { paths: ["/srv/agents"] },
      issuedAt: new Date().toISOString(),
    });
    setCommands([cmd]);
    const applied = await agent.processCommands(() => ({ ok: true }));
    expect(applied).toEqual(["bk-1"]);
    expect(executed.some((args) => args[0] === "backup" && args[1] === "/srv/agents")).toBe(true);
  });
});
