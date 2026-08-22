import { describe, expect, it } from "vitest";
import { FeatureFlagService } from "../src/index.js";

describe("feature flags", () => {
  it("falls back through scopes to global", async () => {
    const svc = new FeatureFlagService();
    await svc.setFlag({ flag: "new_builder", scope: "global", enabled: true, actor: "admin" });
    expect(await svc.isEnabled("new_builder")).toBe(true);

    // Org-level override wins over global.
    await svc.setFlag({ flag: "new_builder", scope: "organization", scopeKey: "org-laggard", enabled: false, actor: "admin" });
    expect(await svc.isEnabled("new_builder", { orgId: "org-laggard" })).toBe(false);
    expect(await svc.isEnabled("new_builder", { orgId: "org-other" })).toBe(true);

    // User override beats org.
    await svc.setFlag({ flag: "new_builder", scope: "user", scopeKey: "u-early", enabled: true, actor: "admin" });
    expect(await svc.isEnabled("new_builder", { orgId: "org-laggard", userId: "u-early" })).toBe(true);
  });

  it("supports region, plan and provider scoped flags", async () => {
    const svc = new FeatureFlagService();
    await svc.setFlag({ flag: "ngn_checkout", scope: "region", scopeKey: "NG", enabled: true, actor: "admin" });
    await svc.setFlag({ flag: "voice_beta", scope: "plan", scopeKey: "max", enabled: true, actor: "admin" });
    await svc.setFlag({ flag: "hetzner_traffic", scope: "provider", scopeKey: "hetzner", enabled: true, actor: "admin" });

    expect(await svc.isEnabled("ngn_checkout", { regionCode: "NG" })).toBe(true);
    expect(await svc.isEnabled("ngn_checkout", { regionCode: "US" })).toBe(false);
    expect(await svc.isEnabled("voice_beta", { planTier: "max" })).toBe(true);
    expect(await svc.isEnabled("voice_beta", { planTier: "plus" })).toBe(false);
    expect(await svc.isEnabled("hetzner_traffic", { providerName: "hetzner" })).toBe(true);
  });

  it("rollout percentages bucket deterministically per identity", async () => {
    const svc = new FeatureFlagService();
    await svc.setFlag({ flag: "canary_api", scope: "global", enabled: true, rolloutPct: 50, actor: "admin" });
    const first = await svc.isEnabled("canary_api", { userId: "u-42" });
    for (let i = 0; i < 5; i += 1) {
      expect(await svc.isEnabled("canary_api", { userId: "u-42" })).toBe(first);
    }
  });

  it("audits every change with actor and action", async () => {
    const svc = new FeatureFlagService();
    await svc.setFlag({ flag: "dark_mode", scope: "global", enabled: true, actor: "admin-1" });
    await svc.removeFlag({ flag: "dark_mode", scope: "global", actor: "admin-2" });
    const audit = await svc.listAudit("dark_mode");
    expect(audit.map((a) => a.action)).toEqual(["set", "removed"]);
    expect(audit[0]?.actor).toBe("admin-1");
    expect(audit[1]?.actor).toBe("admin-2");
  });

  it("rejects invalid rollout percentages", async () => {
    const svc = new FeatureFlagService();
    await expect(
      svc.setFlag({ flag: "x", scope: "global", enabled: true, rolloutPct: 150, actor: "a" }),
    ).rejects.toThrow(/rolloutPct/);
  });

  it("unconfigured flags default to false without erroring", async () => {
    const svc = new FeatureFlagService();
    expect(await svc.isEnabled("never_configured")).toBe(false);
  });
});
