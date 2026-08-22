import { describe, expect, it } from "vitest";
import {
  containerName,
  InMemoryContainerDriver,
  RuntimeSupervisor,
  SupervisorError,
} from "../src/index.js";

function spec(overrides: Partial<Parameters<RuntimeSupervisor["launch"]>[0]> = {}) {
  return {
    orgId: "org-1",
    agentId: "agent-1",
    sessionId: "sess-1",
    image: "mox/computer-runtime:latest",
    limits: { cpus: 2, memoryMb: 2048 },
    ...overrides,
  };
}

describe("deterministic container naming", () => {
  it("derives mox-<org>-<agent>-<session> names", () => {
    expect(containerName({ orgId: "org-1", agentId: "agent-1", sessionId: "sess-1" })).toBe(
      "mox-org-1-agent-1-sess-1",
    );
  });

  it("sanitizes hostile characters, strips leading dots, and truncates segments", () => {
    const name = containerName({
      orgId: "../etc/passwd",
      agentId: "a".repeat(64),
      sessionId: "SESS_9",
    });
    // No path separators or leading dots survive; segments cap at 32 chars.
    expect(name).toBe(`mox-etc-passwd-${"a".repeat(32)}-sess_9`);
    expect(name).not.toMatch(/[/\\]/);
  });

  it("is collision-free across sessions of the same agent", () => {
    const a = containerName({ orgId: "o", agentId: "a", sessionId: "s1" });
    const b = containerName({ orgId: "o", agentId: "a", sessionId: "s2" });
    expect(a).not.toBe(b);
  });
});

describe("RuntimeSupervisor launch isolation", () => {
  it("launches with a derived name and reports running state", async () => {
    const sup = new RuntimeSupervisor({ driver: new InMemoryContainerDriver() });
    const rec = await sup.launch(spec());
    expect(rec.name).toBe("mox-org-1-agent-1-sess-1");
    expect(rec.state).toBe("running");
    expect(await sup.get(rec.name)).toMatchObject({ restarts: 0 });
  });

  it("refuses duplicate names (per-session uniqueness)", async () => {
    const sup = new RuntimeSupervisor({ driver: new InMemoryContainerDriver() });
    await sup.launch(spec());
    await expect(sup.launch(spec())).rejects.toBeInstanceOf(SupervisorError);
  });

  it("enforces the global capacity limit", async () => {
    const driver = new InMemoryContainerDriver();
    const sup = new RuntimeSupervisor({ driver });
    for (let i = 0; i < 3; i += 1) {
      await sup.launch(spec({ sessionId: `s${i}`, limits: { cpus: 1, memoryMb: 256, maxContainers: 3 } }));
    }
    await expect(
      sup.launch(spec({ sessionId: "overflow", limits: { cpus: 1, memoryMb: 256, maxContainers: 3 } })),
    ).rejects.toMatchObject({ message: expect.stringContaining("capacity") });
  });

  it("rejects public bindings of internal control ports (never-public invariant)", async () => {
    const sup = new RuntimeSupervisor({ driver: new InMemoryContainerDriver() });
    await expect(
      sup.launch(spec({ portBindings: [{ hostIp: "0.0.0.0", hostPort: 9222 }] })),
    ).rejects.toMatchObject({ message: expect.stringContaining("must not be public") });
    // Loopback binding of the same port is fine.
    await expect(
      sup.launch(spec({ portBindings: [{ hostIp: "127.0.0.1", hostPort: 9222 }] })),
    ).resolves.toBeDefined();
  });
});

describe("health sweep + bounded restarts (crash/restart)", () => {
  it("restarts unhealthy containers within budget then crashes out", async () => {
    const driver = new InMemoryContainerDriver();
    const sup = new RuntimeSupervisor({ driver, maxRestarts: 2 });
    await sup.launch(spec());
    driver.crash("mox-org-1-agent-1-sess-1");

    const first = await sup.sweepHealth();
    expect(first[0]).toMatchObject({ action: "restarted" });
    driver.crash("mox-org-1-agent-1-sess-1");
    await sup.sweepHealth();
    driver.crash("mox-org-1-agent-1-sess-1");
    const third = await sup.sweepHealth();
    expect(third[0]).toMatchObject({ action: "crashed" });
    expect(sup.get("mox-org-1-agent-1-sess-1")?.lastError).toContain("exceeded 2 restarts");
  });

  it("healthy containers report healthy without restart churn", async () => {
    const sup = new RuntimeSupervisor({ driver: new InMemoryContainerDriver() });
    await sup.launch(spec());
    const results = await sup.sweepHealth();
    expect(results[0]).toMatchObject({ action: "healthy" });
    expect(sup.get("mox-org-1-agent-1-sess-1")?.restarts).toBe(0);
  });

  it("reportCrash records a secret-free reason", async () => {
    const sup = new RuntimeSupervisor({ driver: new InMemoryContainerDriver() });
    await sup.launch(spec());
    const rec = sup.reportCrash("mox-org-1-agent-1-sess-1", "exit: token=sk-proj0123456789 leaked");
    expect(rec.state).toBe("crashed");
    expect(rec.lastError).not.toContain("sk-proj0123456789");
    expect(rec.lastError).toContain("[redacted]");
  });
});

describe("tenant isolation", () => {
  it("listForOrg exposes only that org's containers", async () => {
    const sup = new RuntimeSupervisor({ driver: new InMemoryContainerDriver() });
    await sup.launch(spec({ sessionId: "s1" }));
    await sup.launch(spec({ orgId: "org-2", agentId: "agent-2", sessionId: "s2" }));
    const org1 = sup.listForOrg("org-1");
    expect(org1).toHaveLength(1);
    expect(org1.every((r) => r.spec.orgId === "org-1")).toBe(true);
  });

  it("stop/terminate lifecycle updates records", async () => {
    const driver = new InMemoryContainerDriver();
    const sup = new RuntimeSupervisor({ driver });
    const rec = await sup.launch(spec());
    const stopped = await sup.stop(rec.name);
    expect(stopped.state).toBe("stopped");
    await sup.terminate(rec.name);
    expect(sup.get(rec.name)).toBeUndefined();
    expect(await driver.list()).toHaveLength(0);
  });
});
