import { describe, expect, it } from "vitest";
import {
  EntitlementService,
  InMemoryEntitlementStore,
} from "../src/index.js";

const PLAN_V1 = "plan-plus-v1";

async function service(): Promise<EntitlementService> {
  const svc = new EntitlementService(new InMemoryEntitlementStore());
  await svc.define({ key: "max_agents", valueType: "integer", description: "agents", defaultValue: 1 });
  await svc.define({ key: "developer_mode", valueType: "boolean", description: "dev mode", defaultValue: false });
  await svc.setPlanValues(PLAN_V1, { max_agents: 5 });
  return svc;
}

describe("entitlements", () => {
  it("resolves plan values over defaults", async () => {
    const svc = await service();
    const resolved = await svc.resolve("org-1", "max_agents", PLAN_V1);
    expect(resolved.value).toBe(5);
    expect(resolved.source).toBe("plan");
    expect((await svc.resolve("org-1", "developer_mode", PLAN_V1)).value).toBe(false);
  });

  it("org override beats plan", async () => {
    const svc = await service();
    await svc.grantOverride({ orgId: "org-1", key: "max_agents", value: 20, grantedBy: "admin-1" });
    const resolved = await svc.resolve("org-1", "max_agents", PLAN_V1);
    expect(resolved.source).toBe("org_override");
    expect(resolved.value).toBe(20);
  });

  it("expired overrides stop applying without deletion", async () => {
    const svc = await service();
    await svc.grantOverride({
      orgId: "org-1",
      key: "max_agents",
      value: 99,
      grantedBy: "admin-1",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    const before = await svc.resolve("org-1", "max_agents", PLAN_V1, "2025-12-31T23:59:59.000Z");
    expect(before.value).toBe(99);
    const after = await svc.resolve("org-1", "max_agents", PLAN_V1, "2026-06-01T00:00:00.000Z");
    expect(after.source).toBe("plan");
  });

  it("enterprise custom contract beats every other layer", async () => {
    const svc = await service();
    await svc.grantOverride({ orgId: "org-1", key: "max_agents", value: 50, grantedBy: "admin-1" });
    await svc.applyContract({
      orgId: "org-1",
      contractId: "CT-001",
      values: { max_agents: 500, developer_mode: true },
      active: true,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    const agents = await svc.resolve("org-1", "max_agents", PLAN_V1, "2026-02-01T00:00:00.000Z");
    expect(agents).toEqual({ key: "max_agents", value: 500, source: "custom_contract" });
    const dev = await svc.isEnabled("org-1", "developer_mode", PLAN_V1, "2026-02-01T00:00:00.000Z");
    expect(dev).toBe(true);
  });

  it("inactive or out-of-window contracts are ignored", async () => {
    const svc = await service();
    await svc.applyContract({
      orgId: "org-2",
      contractId: "CT-002",
      values: { max_agents: 1000 },
      active: true,
      effectiveFrom: "2030-01-01T00:00:00.000Z",
    });
    const resolved = await svc.resolve("org-2", "max_agents", PLAN_V1, "2026-01-01T00:00:00.000Z");
    expect(resolved.source).toBe("plan");
  });

  it("revoking an override falls back down the precedence chain", async () => {
    const svc = await service();
    await svc.grantOverride({ orgId: "org-1", key: "max_agents", value: 42, grantedBy: "admin-1" });
    await svc.revokeOverride("org-1", "max_agents");
    const resolved = await svc.resolve("org-1", "max_agents", PLAN_V1);
    expect(resolved.source).toBe("plan");
    expect(resolved.value).toBe(5);
  });

  it("limitOf returns numeric limits and isEnabled gates booleans", async () => {
    const svc = await service();
    expect(await svc.limitOf("org-1", "max_agents", PLAN_V1)).toBe(5);
    expect(await svc.isEnabled("org-1", "developer_mode", PLAN_V1)).toBe(false);
  });
});
