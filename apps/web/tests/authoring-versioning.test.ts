/**
 * Phase 02 §K: web authoring / versioning / infrastructure tests that run
 * without the backend. They exercise the in-memory DemoMoxApi stand-in against
 * canonical contracts (the same behaviors the hosted routes implement) plus the
 * pure Simple-mode round-trip domain logic.
 */

import { describe, expect, it } from "vitest";
import { DemoMoxApi } from "../src/api/demo-api.js";
import { permissionPresetFromDefinition, simpleInputFromDefinition } from "../src/domain/authoring.js";
import type { CreateAgentDraftInput, SimpleAgentInput } from "../src/api/types.js";

const simpleDraft = (overrides: Partial<SimpleAgentInput> = {}): CreateAgentDraftInput => ({
  mode: "simple",
  slug: "ops-scout",
  input: {
    displayName: "Ops Scout",
    role: "SRE",
    instructions: "Watch dashboards and report anomalies.",
    model: "p_openai/gpt-4.1",
    toolNames: ["browse", "terminal"],
    browserEnabled: true,
    permissionsPreset: "balanced",
    target: { kind: "sandbox" },
    ...overrides,
  },
});

describe("Phase 02 §B/§C — authoring & versioning (web demo seam)", () => {
  it("createAgentDraft returns an unpublished draft with revision 0", async () => {
    const api = new DemoMoxApi();
    const result = await api.createAgentDraft(simpleDraft());
    expect(result.agentId.length).toBeGreaterThan(0);
    expect(result.slug).toBe("ops-scout");
    expect(result.status).toBe("draft");
    expect(result.currentVersion).toBe(0);

    const roster = await api.listAgents();
    const created = roster.find((a) => a.agentId === result.agentId);
    expect(created).toBeDefined();
    expect(created?.definition.identity.displayName).toBe("Ops Scout");
    // Drafts are addressable by the same agentId (never a synthetic id).
    expect(await api.getAgent(result.agentId)).toBeDefined();
  });

  it("rejects a duplicate slug honestly", async () => {
    const api = new DemoMoxApi();
    await api.createAgentDraft(simpleDraft());
    await expect(api.createAgentDraft(simpleDraft())).rejects.toThrow(/already exists/);
  });

  it("publish/update/diff/rollback mirror the canonical workflow", async () => {
    const api = new DemoMoxApi();
    const created = await api.createAgentDraft(simpleDraft());
    const agentId = created.agentId;

    const pub1 = await api.publishAgent(agentId, "initial release");
    expect(pub1.revision).toBe(1);

    await api.updateAgentDraft(
      agentId,
      simpleDraft({ instructions: "Watch dashboards AND page the on-call.", model: "p_anthropic/claude-sonnet-4" }),
    );
    const pub2 = await api.publishAgent(agentId, "tightened ops prompt");
    expect(pub2.revision).toBe(2);

    const versions = await api.listAgentVersions(agentId);
    expect(versions.map((v) => v.revision)).toEqual([1, 2]);
    expect(versions[1]?.changelog).toBe("tightened ops prompt");

    const diff = await api.diffAgentVersions(agentId, 1, 2);
    expect(diff.changes).toContain("instructions");
    expect(diff.changes).toContain("model");

    await api.rollbackAgent(agentId, 1);
    const summary = await api.getAgent(agentId);
    expect(summary?.currentVersion).toBe(1);
    expect(summary?.definition.instructions.text).toBe("Watch dashboards and report anomalies.");
  });

  it("rollback rejects an unpublished revision", async () => {
    const api = new DemoMoxApi();
    const created = await api.createAgentDraft(simpleDraft());
    await expect(api.rollbackAgent(created.agentId, 7)).rejects.toThrow(/not found/);
  });
});

describe("Phase 02 §B — Simple-mode round-trip domain logic", () => {
  it("simpleInputFromDefinition round-trips the mutable Simple fields", async () => {
    const api = new DemoMoxApi();
    const seed = (await api.listAgents())[0]!;
    const input = simpleInputFromDefinition(seed.definition);
    const created = await api.createAgentDraft({ mode: "simple", slug: "roundtrip", input });
    const summary = (await api.getAgent(created.agentId))!;
    const rebuilt = simpleInputFromDefinition(summary.definition);
    expect(rebuilt.displayName).toBe(input.displayName);
    expect(rebuilt.role).toBe(input.role);
    expect(rebuilt.instructions).toBe(input.instructions);
    expect(rebuilt.model).toBe(input.model);
    expect(rebuilt.browserEnabled).toBe(input.browserEnabled);
    expect([...rebuilt.toolNames].sort()).toEqual([...input.toolNames].sort());
    expect(rebuilt.permissionsPreset).toBe(input.permissionsPreset);
    expect(rebuilt.target).toEqual(input.target);
  });

  it("permissionPresetFromDefinition maps toolPolicy/approval gates", () => {
    const full = { permissions: { toolPolicy: "allow-all" as const, requireApprovalFor: undefined as never } };
    const safe = { permissions: { toolPolicy: "default" as const, requireApprovalFor: ["computer" as const] } };
    const balanced = { permissions: { toolPolicy: "default" as const, requireApprovalFor: ["spend" as const] } };
    expect(permissionPresetFromDefinition(full)).toBe("full");
    expect(permissionPresetFromDefinition(safe)).toBe("safe");
    expect(permissionPresetFromDefinition(balanced)).toBe("balanced");
  });
});

describe("Phase 02 §D — thread archive", () => {
  it("archived threads disappear from the agent's thread list", async () => {
    const api = new DemoMoxApi();
    const before = await api.listThreads("a_writer");
    expect(before.length).toBeGreaterThan(0);
    await api.archiveThread("t_a_writer");
    const after = await api.listThreads("a_writer");
    expect(after).toHaveLength(0);
  });
});

describe("Phase 02 §H — server lifecycle actions (web demo seam)", () => {
  it("stop/start/restart/cancel transition through orchestrator-backed states", async () => {
    const api = new DemoMoxApi();
    const servers = await api.listServers();
    const srv = servers.find((s) => s.state === "running")!;

    await api.serverAction(srv.orderId, "restart");
    expect((await api.listServers()).find((s) => s.orderId === srv.orderId)?.state).toBe("running");

    await api.serverAction(srv.orderId, "stop");
    expect((await api.listServers()).find((s) => s.orderId === srv.orderId)?.state).toBe("stopped");

    await api.serverAction(srv.orderId, "start");
    expect((await api.listServers()).find((s) => s.orderId === srv.orderId)?.state).toBe("running");

    await api.serverAction(srv.orderId, "cancel");
    expect((await api.listServers()).find((s) => s.orderId === srv.orderId)?.state).toBe("canceled");
  });

  it("resize requires the compute class code", async () => {
    const api = new DemoMoxApi();
    const srv = (await api.listServers())[0]!;
    await expect(api.serverAction(srv.orderId, "resize")).rejects.toThrow(/computeClassCode/);
    await api.serverAction(srv.orderId, "resize", "c_2xlarge");
    const updated = (await api.listServers()).find((s) => s.orderId === srv.orderId)!;
    expect(updated.computeClass).toBe("c_2xlarge");
    expect(updated.state).toBe("resizing");
  });
});

describe("Phase 02 §I — deployments (web demo seam)", () => {
  it("only published revisions can be deployed or rolled back to", async () => {
    const api = new DemoMoxApi();
    const created = await api.createAgentDraft(simpleDraft());
    const agentId = created.agentId;

    await expect(api.deployAgent({ agentId, revision: 1, target: { kind: "sandbox" } })).rejects.toThrow(/not published/);

    await api.publishAgent(agentId, "first");
    const dep = await api.deployAgent({ agentId, revision: 1, target: { kind: "sandbox" } });
    expect(dep.ok).toBe(true);

    await api.publishAgent(agentId, "second");
    const list = await api.listDeployments();
    const mine = list.find((d) => d.agentId === agentId)!;
    expect(mine.versionId).toContain("_1");

    await expect(api.deploymentRollback(mine.deploymentId, 99)).rejects.toThrow(/not published/);
    const rolled = await api.deploymentRollback(mine.deploymentId, 1);
    expect(rolled.state).toBe("desired");

    const redeployed = await api.redeployDeployment(mine.deploymentId);
    expect(redeployed.state).toBe("desired");
  });
});