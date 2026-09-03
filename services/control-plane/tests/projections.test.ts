/**
 * Phase 01 §C/§D/§F/§H: pure projection unit tests (no DB required).
 *
 * These prove the product-truth projections never fabricate state or telemetry:
 * server lifecycle state is preserved, missing telemetry is explicitly
 * unavailable (null), deployments derive state/target/version from real
 * reconciled authorities, and model availability follows connection +
 * credential status instead of blanket `available: true`.
 */

import { describe, expect, it } from "vitest";
import {
  deploymentVersionId,
  projectDeploymentState,
  projectDeploymentTarget,
  projectModelAvailability,
  projectServerSummary,
  projectSupportNodeHealth,
  projectSupportServerOrder,
  supportSafeErrorSummary,
  supportSafeSuspensionReason,
  validateSupportNoteText,
  type ServerOrderView,
} from "../src/projections.js";

function order(overrides: Partial<ServerOrderView> = {}): ServerOrderView {
  const base: ServerOrderView = {
    id: "ord_1",
    hostname: "box-1",
    state: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  return { ...base, ...overrides };
}

describe("server state projection (§C)", () => {
  it("preserves the actual lifecycle state, not collapsing non-running to provisioning", () => {
    expect(projectServerSummary(order({ state: "running" })).state).toBe("running");
    expect(projectServerSummary(order({ state: "error" })).state).toBe("error");
    expect(projectServerSummary(order({ state: "stopped" })).state).toBe("stopped");
    expect(projectServerSummary(order({ state: "resizing" })).state).toBe("resizing");
    expect(projectServerSummary(order({ state: "requested" })).state).toBe("requested");
  });

  it("uses provider instance id when present, else the order id", () => {
    expect(projectServerSummary(order({ providerInstanceId: "i-abc123" })).serverId).toBe("i-abc123");
    expect(projectServerSummary(order({ providerInstanceId: undefined })).serverId).toBe("ord_1");
  });
});

describe("unavailable telemetry (§C)", () => {
  it("reports telemetry as explicitly unavailable (null), never fabricated zeros", () => {
    const s = projectServerSummary(order({ state: "error" }));
    expect(s.agentsRunning).toBeNull();
    expect(s.cpuPct).toBeNull();
    expect(s.memPct).toBeNull();
  });

  it("keeps provider internals off the customer-safe summary (compute-class abstraction)", () => {
    const s = projectServerSummary(order({ providerName: "some-provider", lastError: "disk full" }));
    expect("provider" in s).toBe(false);
    expect(s.lastError).toBe("disk full");
  });
});

describe("real deployment projection (§D)", () => {
  it("derives state from the orchestrator order truth", () => {
    expect(projectDeploymentState("running", "2026-01-01T00:00:00Z")).toBe("running");
    expect(projectDeploymentState("provisioning", undefined)).toBe("provisioning");
    expect(projectDeploymentState("error", undefined)).toBe("failed");
    expect(projectDeploymentState("stopped", undefined)).toBe("stopped");
  });

  it("degrades a running order whose node stopped heartbeating", () => {
    expect(projectDeploymentState("running", undefined)).toBe("degraded");
    expect(projectDeploymentState("running", "2026-01-01T00:00:00Z")).toBe("running");
  });

  it("reports the durable desired marker when no compute authority exists", () => {
    expect(projectDeploymentState(undefined, undefined)).toBe("desired");
  });

  it("projects the real target kind, not a hardcoded sandbox", () => {
    expect(projectDeploymentTarget("customer_vps", "ord_9")).toEqual({ kind: "customer-vps", vpsId: "ord_9" });
    expect(projectDeploymentTarget("sandbox", undefined)).toEqual({ kind: "sandbox" });
    expect(projectDeploymentTarget("shared_host", undefined).kind).toBe("mox-cloud");
    expect(projectDeploymentTarget("dedicated_vps", undefined).kind).toBe("mox-cloud");
  });

  it("builds a durable version identity from the revision (not a client-only number)", () => {
    expect(deploymentVersionId("agent_1", 3)).toBe("agent_1@3");
  });
});

describe("model availability projection (§F)", () => {
  it("is not available until a provider connection is configured with credentials", () => {
    expect(projectModelAvailability("configured", true).state).toBe("available");
    expect(projectModelAvailability("configured", false).state).toBe("not_configured");
    expect(projectModelAvailability("error", true).state).toBe("error");
    expect(projectModelAvailability("unconfigured", true).state).toBe("not_configured");
    expect(projectModelAvailability("disabled", true).state).toBe("not_configured");
  });
});

describe("support-safe diagnostics (§Support)", () => {
  it("summarizes server errors without returning raw provider text or secrets", () => {
    const projected = projectSupportServerOrder({
      id: "ord_1",
      orgId: "org_1",
      computeClassCode: "SMALL",
      state: "error",
      providerName: "hetzner",
      regionCode: "fsn1",
      attemptCount: 2,
      lastError: "auth failed for token sk_live_secret at host 10.0.0.5",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:05:00Z",
    });

    const json = JSON.stringify(projected);
    expect(projected.lifecycle.errorSummary).toBe("provider authorization issue");
    expect(json).not.toContain("sk_live_secret");
    expect(json).not.toContain("10.0.0.5");
  });

  it("projects node heartbeat health without node ids, metrics, or tokens", () => {
    expect(projectSupportNodeHealth(undefined).health).toBe("not_enrolled");
    expect(
      projectSupportNodeHealth(
        { status: "active", version: "1.2.3", lastHeartbeatAt: "2026-01-01T00:00:00Z" },
        new Date("2026-01-01T00:05:00Z"),
      ),
    ).toEqual({
      status: "active",
      version: "1.2.3",
      lastSeenAt: "2026-01-01T00:00:00Z",
      health: "active",
    });
    expect(
      projectSupportNodeHealth(
        { status: "active", version: "1.2.3", lastHeartbeatAt: "2026-01-01T00:00:00Z" },
        new Date("2026-01-01T00:30:00Z"),
      ).health,
    ).toBe("stale");
  });

  it("coarsens arbitrary suspension and notification error reasons", () => {
    expect(supportSafeSuspensionReason("manual admin hold: investigate customer@example.com")).toBe("manual platform hold");
    expect(supportSafeSuspensionReason("chargeback ref ch_123")).toBe("payment reversal review");
    expect(supportSafeErrorSummary("SMTP timeout for secret token abc")).toBe("operation timed out");
  });

  it("validates support notes instead of truncating or accepting executable markup", () => {
    expect(validateSupportNoteText(" Followed up by email ").ok).toBe(true);
    expect(validateSupportNoteText("x".repeat(4001))).toMatchObject({ ok: false });
    expect(validateSupportNoteText("<script>alert(1)</script>")).toMatchObject({ ok: false });
  });
});
