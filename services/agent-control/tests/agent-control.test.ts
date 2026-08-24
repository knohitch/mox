import { describe, expect, it } from "vitest";
import { EntitlementService, InMemoryEntitlementStore } from "@mox/entitlements";
import { compileDeveloperMode, compileSimpleMode } from "../src/builder.js";
import { AgentControlService } from "../src/service.js";
import { InMemoryAgentControlStore, type NodeChannel } from "../src/store.js";

function simpleInput(overrides: Partial<Parameters<typeof compileSimpleMode>[0]> = {}) {
  return {
    orgId: "org-1",
    slug: "sales-helper",
    displayName: "Sales Helper",
    role: "SDR",
    instructions: "You qualify inbound leads.",
    model: "openai/gpt-5.2",
    toolNames: ["web.search"],
    knowledgeIds: ["kb-pricing"],
    browserEnabled: true,
    channelIds: ["ch-web"],
    schedule: { cron: "0 9 * * MON", timezone: "UTC", prompt: "Summarize pipeline" },
    target: { kind: "customer-vps" as const, vpsId: "srv-777" },
    permissionsPreset: "balanced" as const,
    ...overrides,
  };
}

function makeDefinition() {
  return compileSimpleMode(simpleInput());
}

interface RecordedCall {
  kind: "apply" | "stop";
  nodeId: string;
  name?: string;
}

function fakeNodeChannel() {
  const calls: RecordedCall[] = [];
  const channel: NodeChannel = {
    async applyWorkload(input) {
      calls.push({ kind: "apply", nodeId: input.nodeId });
    },
    async stopWorkload(nodeId, name) {
      calls.push({ kind: "stop", nodeId, name });
    },
  };
  return { channel, calls };
}

async function service(options: {
  developerMode?: boolean;
  agentLimit?: number;
} = {}) {
  const planVersionId = "plan-version-test";
  const entitlements = new EntitlementService(new InMemoryEntitlementStore());
  await entitlements.setPlanValues(planVersionId, {
    developer_mode: options.developerMode ?? true,
    active_concurrent_agents: options.agentLimit ?? 10,
    cli_sessions: true,
  });
  const { channel, calls } = fakeNodeChannel();
  const svc = new AgentControlService(new InMemoryAgentControlStore(), {
    entitlements,
    nodeChannel: channel,
    serverOwnership: {
      async ownerOf(serverOrderId) {
        return serverOrderId === "srv-777" ? "org-1" : undefined;
      },
    },
    commercialPlans: {
      async entitledPlanVersionId(orgId) {
        return orgId === "org-1" ? planVersionId : undefined;
      },
    },
  });
  return { svc, entitlements, calls };
}

describe("agent builder", () => {
  it("compiles Simple Mode input into a canonical AgentDefinition", () => {
    const def = makeDefinition();
    expect(def.schemaVersion).toBe(1);
    expect(def.authoring.mode).toBe("simple");
    expect(def.model).toEqual({ providerId: "openai", modelId: "gpt-5.2" });
    expect(def.computer.enabled).toBe(true);
    expect(def.permissions.requireApprovalFor).toEqual(["spend", "external-send"]);
    expect(def.schedules).toHaveLength(1);
  });

  it("round-trips Simple and Developer modes through the same schema", () => {
    const simpleDef = makeDefinition();
    // Developer mode edits the raw definition (e.g., adds env-style metadata).
    const devDef = compileDeveloperMode({
      ...JSON.parse(JSON.stringify(simpleDef)),
      authoring: { mode: "developer", ui: { showAdvanced: true } },
      metadata: { runtimeImage: "ghcr.io/mox/mox-runtime:2.0.0" },
    });
    expect(devDef.authoring.mode).toBe("developer");
    expect(devDef.metadata.runtimeImage).toBe("ghcr.io/mox/mox-runtime:2.0.0");
    // Both validate identically — one engine.
    expect(devDef.agentId).toBe(simpleDef.agentId);
  });

  it("rejects malformed model selections", () => {
    expect(() => compileSimpleMode(simpleInput({ model: "just-a-model" }))).toThrow(/provider\/model/);
  });

  it("applies permission presets", () => {
    expect(makeDefinition().permissions.toolPolicy).toBe("default");
    expect(
      compileSimpleMode(simpleInput({ permissionsPreset: "full" })).permissions.toolPolicy,
    ).toBe("allow-all");
    expect(
      compileSimpleMode(simpleInput({ permissionsPreset: "safe" })).permissions.requireApprovalFor,
    ).toEqual(["computer", "spend", "external-send", "deployment"]);
  });
});

describe("agent versioning", () => {
  it("publishes immutable versions and never mutates them in place", async () => {
    const { svc } = await service();
    await svc.createDraft({ orgId: "org-1", definition: makeDefinition(), userId: "u1" });
    const v1 = await svc.publish("org-1", "sales-helper", { userId: "u1", changelog: "init" });

    // Edit draft after publish.
    const draft = await svc.getDraft("org-1", "sales-helper");
    draft.draft.instructions.text += " Follow GDPR.";
    const v2 = await svc.publish("org-1", "sales-helper", { userId: "u1", changelog: "gdpr" });

    expect(v1.revision).toBe(1);
    expect(v2.revision).toBe(2);
    const history = await svc.listVersions("org-1", "sales-helper");
    expect(history[0]?.definition.instructions.text).not.toContain("GDPR");
    expect(history[1]?.definition.instructions.text).toContain("GDPR");

    const changes = await svc.diffVersions("org-1", "sales-helper", 1, 2);
    expect(changes).toContain("instructions");
  });

  it("blocks developer-mode publishing when not entitled", async () => {
    const { svc } = await service({ developerMode: false });
    const def = compileDeveloperMode({
      ...JSON.parse(JSON.stringify(makeDefinition())),
      authoring: { mode: "developer" },
    });
    await svc.createDraft({ orgId: "org-1", definition: def, userId: "u1" });
    await expect(svc.publish("org-1", "sales-helper", { userId: "u1" })).rejects.toThrow(/not enabled/);
  });

  it("enforces concurrent-agent limits via entitlements, not plan names", async () => {
    const { svc } = await service({ agentLimit: 1 });
    await svc.createDraft({ orgId: "org-1", definition: makeDefinition(), userId: "u1" });
    await svc.publish("org-1", "sales-helper", { userId: "u1" });
    await svc.deploy({ orgId: "org-1", slug: "sales-helper", revision: 1, target: { kind: "customer-vps", vpsId: "srv-777" } });

    // Second agent would exceed limit of 1.
    await svc.createDraft({
      orgId: "org-1",
      definition: compileSimpleMode(simpleInput({ slug: "second-agent" })),
      userId: "u1",
    });
    await svc.publish("org-1", "second-agent", { userId: "u1" });
    await expect(
      svc.deploy({ orgId: "org-1", slug: "second-agent", revision: 1, target: { kind: "sandbox" } }),
    ).rejects.toThrow(/concurrent agents/);
  });
});

describe("deployments", () => {
  it("deploys pinned revisions to Mox Node and reconciles to running", async () => {
    const { svc, calls } = await service();
    await svc.createDraft({ orgId: "org-1", definition: makeDefinition(), userId: "u1" });
    await svc.publish("org-1", "sales-helper", { userId: "u1" });
    const dep = await svc.deploy({
      orgId: "org-1",
      slug: "sales-helper",
      revision: 1,
      target: { kind: "customer-vps", vpsId: "srv-777" },
    });
    expect(dep.state).toBe("desired");

    const result = await svc.reconcile();
    expect(result.reconciled).toBe(1);
    const updated = await svc.store.getDeployment(dep.deploymentId);
    expect(updated?.state).toBe("running");
    expect(calls.some((c) => c.kind === "apply" && c.nodeId === "srv-777")).toBe(true);
  });

  it("refuses to deploy unpublished drafts", async () => {
    const { svc } = await service();
    await svc.createDraft({ orgId: "org-1", definition: makeDefinition(), userId: "u1" });
    await expect(
      svc.deploy({ orgId: "org-1", slug: "sales-helper", revision: 3, target: { kind: "sandbox" } }),
    ).rejects.toThrow(/not published/);
  });

  it("rollback re-pins an older version without mutating running state invisibly", async () => {
    const { svc, calls } = await service();
    await svc.createDraft({ orgId: "org-1", definition: makeDefinition(), userId: "u1" });
    await svc.publish("org-1", "sales-helper", { userId: "u1", changelog: "v1" });
    await svc.deploy({ orgId: "org-1", slug: "sales-helper", revision: 1, target: { kind: "customer-vps", vpsId: "srv-777" } });
    await svc.reconcile();

    // Change + publish v2 + deploy.
    const draft = await svc.getDraft("org-1", "sales-helper");
    draft.draft.instructions.text += " v2 behavior.";
    await svc.publish("org-1", "sales-helper", { userId: "u1" });
    await svc.deploy({ orgId: "org-1", slug: "sales-helper", revision: 2, target: { kind: "customer-vps", vpsId: "srv-777" } });
    await svc.reconcile();

    // Rollback to v1 stops the old workload and re-applies the old image.
    const rolled = await svc.rollback({ orgId: "org-1", slug: "sales-helper", toRevision: 1 });
    expect(rolled?.revision).toBe(1);
    expect(calls.filter((c) => c.kind === "stop")).toHaveLength(1);
    expect(calls.at(-1)?.kind).toBe("apply");
  });
});

describe("browser terminal", () => {
  it("opens audited sessions only for owned servers on entitled plans", async () => {
    const { svc } = await service();
    const session = await svc.openTerminal({ orgId: "org-1", userId: "u1", serverOrderId: "srv-777" });
    expect(session.state).toBe("open");

    // Another org's server is unaddressable.
    await expect(
      svc.openTerminal({ orgId: "org-2", userId: "u2", serverOrderId: "srv-777" }),
    ).rejects.toThrow(/commercially entitled/);

    // Unknown server too.
    await expect(
      svc.openTerminal({ orgId: "org-1", userId: "u1", serverOrderId: "srv-nope" }),
    ).rejects.toThrow(/owned by your organization/);
  });

  it("denies terminal access when plan lacks cli_sessions entitlement", async () => {
    const planVersionId = "plan-version-no-cli";
    const entitlements = new EntitlementService(new InMemoryEntitlementStore());
    await entitlements.setPlanValues(planVersionId, { cli_sessions: false });
    const svc = new AgentControlService(new InMemoryAgentControlStore(), {
      entitlements,
      commercialPlans: {
        async entitledPlanVersionId() {
          return planVersionId;
        },
      },
    });
    await expect(
      svc.openTerminal({ orgId: "org-1", userId: "u1", serverOrderId: "srv-x" }),
    ).rejects.toThrow(/not enabled/);
  });
});
