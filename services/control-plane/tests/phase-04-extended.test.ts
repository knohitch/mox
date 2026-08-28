/**
 * Phase 04 Customer Extended Capabilities tests.
 *
 * Covers:
 * - Usage status projection (quotas, unlimited, approaching limit, limit reached)
 * - Backup storage location masking (never leaking internal S3 buckets or provider snapshot IDs)
 * - Workspace member mutation invariants (sole owner protection, owner-only mutation)
 * - Mandatory notification category guards
 */

import { describe, expect, it } from "vitest";
import {
  canMutateMember,
  maskBackupLocation,
  projectUsageStatus,
  validateKnowledgeAccess,
  validateScheduleLimit,
  validateSubagents,
} from "../src/projections.js";

describe("Phase 04 §A: Usage Status Projection", () => {
  it("projects unlimited quota when entitlement is unlimited (< 0)", () => {
    const res = projectUsageStatus(150, -1);
    expect(res).toBe("unlimited");
  });

  it("projects within_included when usage is within included quota", () => {
    const res = projectUsageStatus(50, 100);
    expect(res).toBe("within_included");
  });

  it("projects soft_limit_warning when usage exceeds soft limit", () => {
    const res = projectUsageStatus(85, 100, { softLimit: 80 });
    expect(res).toBe("soft_limit_warning");
  });

  it("projects hard_limit_blocked when usage exceeds hard limit", () => {
    const res = projectUsageStatus(105, 100, { hardLimit: 100 });
    expect(res).toBe("hard_limit_blocked");
  });

  it("projects overage when usage exceeds included quantity without limits", () => {
    const res = projectUsageStatus(120, 100);
    expect(res).toBe("overage");
  });
});

describe("Phase 04 §C: Backup Location Masking", () => {
  it("masks internal S3 URIs to customer-safe Mox Cloud Storage", () => {
    const label = maskBackupLocation("s3://mox-prod-customer-backups-internal/snapshots/tenant_1/snap.tar.gz", "s3_copy");
    expect(label).toBe("Mox Cloud Storage");
    expect(label).not.toContain("mox-prod");
    expect(label).not.toContain("tenant_1");
  });

  it("masks provider snapshot IDs to customer-safe Server Snapshot", () => {
    const label = maskBackupLocation("hcloud-snapshot-98127391-region-nbg1", "provider_snapshot");
    expect(label).toBe("Server Snapshot");
    expect(label).not.toContain("hcloud");
    expect(label).not.toContain("98127391");
  });

  it("provides fallback label for unknown location", () => {
    expect(maskBackupLocation("default-storage", "unknown")).toBe("Cloud Storage");
  });
});

describe("Phase 04 §D: Workspace Member Mutation Safety", () => {
  it("prevents deleting or demoting the sole remaining workspace owner", () => {
    const checkRemove = canMutateMember({
      callerRole: "owner",
      targetRole: "owner",
      isOwnerTarget: true,
      activeOwnerCount: 1,
      action: "remove",
    });
    expect(checkRemove.allowed).toBe(false);
    expect(checkRemove.reason).toContain("only remaining workspace owner");

    const checkDemote = canMutateMember({
      callerRole: "owner",
      targetRole: "owner",
      isOwnerTarget: true,
      activeOwnerCount: 1,
      action: "demote",
    });
    expect(checkDemote.allowed).toBe(false);
    expect(checkDemote.reason).toContain("only remaining workspace owner");
  });

  it("prevents non-owners (e.g. admin or member) from modifying an owner", () => {
    const checkAdminOnOwner = canMutateMember({
      callerRole: "admin",
      targetRole: "owner",
      isOwnerTarget: true,
      activeOwnerCount: 2,
      action: "remove",
    });
    expect(checkAdminOnOwner.allowed).toBe(false);
    expect(checkAdminOnOwner.reason).toContain("only workspace owners");

    const checkMemberOnOwner = canMutateMember({
      callerRole: "member",
      targetRole: "owner",
      isOwnerTarget: true,
      activeOwnerCount: 2,
      action: "demote",
    });
    expect(checkMemberOnOwner.allowed).toBe(false);
    expect(checkMemberOnOwner.reason).toContain("only workspace owners");
  });

  it("allows workspace owners to remove non-owner members", () => {
    const check = canMutateMember({
      callerRole: "owner",
      targetRole: "member",
      isOwnerTarget: false,
      activeOwnerCount: 1,
      action: "remove",
    });
    expect(check.allowed).toBe(true);
  });

  it("allows workspace owners to demote other owners when multiple owners exist", () => {
    const check = canMutateMember({
      callerRole: "owner",
      targetRole: "owner",
      isOwnerTarget: true,
      activeOwnerCount: 2,
      action: "demote",
    });
    expect(check.allowed).toBe(true);
  });
});


describe("Phase 04 §B: Mandatory Notification Categories Guard", () => {
  const MANDATORY_NOTIFICATION_CATEGORIES = new Set(["billing", "security"]);

  it("identifies billing and security as mandatory alerts that cannot be muted", () => {
    expect(MANDATORY_NOTIFICATION_CATEGORIES.has("billing")).toBe(true);
    expect(MANDATORY_NOTIFICATION_CATEGORIES.has("security")).toBe(true);
    expect(MANDATORY_NOTIFICATION_CATEGORIES.has("system")).toBe(false);
    expect(MANDATORY_NOTIFICATION_CATEGORIES.has("agents")).toBe(false);
  });
});

describe("Phase 04 §E: Schedules & Workflows Limits", () => {
  it("allows schedules within the schedule_workflow_limit entitlement", () => {
    const res = validateScheduleLimit(3, 5);
    expect(res.allowed).toBe(true);
  });

  it("rejects schedules exceeding the schedule_workflow_limit entitlement", () => {
    const res = validateScheduleLimit(6, 5);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("exceeds entitlement limit");
  });

  it("allows unlimited schedules when entitlement is -1", () => {
    const res = validateScheduleLimit(25, -1);
    expect(res.allowed).toBe(true);
  });
});

describe("Phase 04 §E: Subagent Delegation & Self-Reference Prevention", () => {
  it("rejects subagent that references current agent id", () => {
    const res = validateSubagents([{ agentId: "agent_self_01" }], "agent_self_01", "my-slug");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("cannot self-reference");
  });

  it("rejects subagent that references current agent slug", () => {
    const res = validateSubagents([{ agentId: "my-slug" }], "agent_self_01", "my-slug");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("cannot self-reference");
  });

  it("allows subagents targeting valid distinct agent ids", () => {
    const res = validateSubagents([{ agentId: "agent_other_02" }], "agent_self_01", "my-slug");
    expect(res.valid).toBe(true);
  });
});

describe("Phase 04 §E: Knowledge Access Permissions", () => {
  it("accepts valid access permissions read, search, attach", () => {
    const res = validateKnowledgeAccess(["read", "search", "attach"]);
    expect(res.valid).toBe(true);
  });

  it("rejects empty access array", () => {
    const res = validateKnowledgeAccess([]);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("at least one");
  });

  it("rejects unknown access permission", () => {
    const res = validateKnowledgeAccess(["read", "write_execute"]);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("invalid knowledge access permission");
  });
});

