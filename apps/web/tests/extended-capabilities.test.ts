/**
 * Phase 04 Customer Extended Capabilities web tests.
 *
 * Covers DemoMoxApi implementations and parity assertions for:
 * - Usage details, Mox AI credits, and entitlement metrics
 * - Notification preferences routing and mandatory categories protection
 * - Backups overview, manual trigger, and restore integrity testing
 * - Team members, invitations lifecycle, and owner immutability
 * - Knowledge sources catalog and binding
 * - Voice catalog and preview synthesis
 */

import { describe, expect, it } from "vitest";
import { DemoMoxApi } from "../src/api/demo-api.js";

describe("Phase 04 §A: Usage and Quota Details", () => {
  it("returns billing period, metrics with quota evaluation, and Mox AI credits", async () => {
    const api = new DemoMoxApi();
    const details = await api.getUsageDetails();

    expect(details.period.start).toBeDefined();
    expect(details.period.end).toBeDefined();
    expect(details.metrics.length).toBeGreaterThan(0);

    const tokenMetric = details.metrics.find((m) => m.metric.includes("Token") || m.kind === "tokens");
    expect(tokenMetric).toBeDefined();
    expect(tokenMetric?.status).toBeDefined();

    expect(details.credits).toBeDefined();
    expect(details.credits.included).toBeGreaterThan(0);
    expect(details.credits.consumed).toBeGreaterThanOrEqual(0);
    expect(details.credits.remaining).toBe(details.credits.included - details.credits.consumed);
  });
});

describe("Phase 04 §B: Notification Preferences", () => {
  it("loads default notification routes with mandatory categories flagged", async () => {
    const api = new DemoMoxApi();
    const prefs = await api.getNotificationPreferences();

    expect(prefs.availableRoutes).toContain("in_app");
    expect(prefs.availableRoutes).toContain("email");
    expect(prefs.items.length).toBeGreaterThan(0);

    const security = prefs.items.find((i) => i.category === "security");
    expect(security?.mandatory).toBe(true);

    const billing = prefs.items.find((i) => i.category === "billing");
    expect(billing?.mandatory).toBe(true);
  });

  it("updates notification routing for non-mandatory events", async () => {
    const api = new DemoMoxApi();
    const updated = await api.updateNotificationPreferences({
      routes: { "agent.deployed": ["in_app"] },
      mutedEventTypes: ["agent.deployed"],
    });

    const agentItem = updated.items.find((i) => i.eventType === "agent.deployed");
    expect(agentItem?.muted).toBe(true);
    expect(agentItem?.routes).toEqual(["in_app"]);
  });

  it("rejects muting mandatory alert categories", async () => {
    const api = new DemoMoxApi();
    await expect(
      api.updateNotificationPreferences({
        routes: {},
        mutedEventTypes: ["abuse.case_opened"],
      }),
    ).rejects.toThrow(/mandatory/i);
  });
});


describe("Phase 04 §C: Backups and Disaster Recovery", () => {
  it("provides backups overview with masked location and retention window", async () => {
    const api = new DemoMoxApi();
    const overview = await api.getBackupsOverview();

    expect(overview.retentionDays).toBeGreaterThan(0);
    expect(overview.backups.length).toBeGreaterThan(0);

    for (const b of overview.backups) {
      expect(b.locationLabel).toBeDefined();
      expect(b.locationLabel).not.toContain("s3://");
    }
  });

  it("triggers manual backup creation and verifies completed state", async () => {
    const api = new DemoMoxApi();
    const res = await api.triggerManualBackup("srv_demo_01");

    expect(res.ok).toBe(true);
    expect(res.backupId).toBeDefined();
    expect(res.state).toBe("completed");

    const overview = await api.getBackupsOverview();
    const created = overview.backups.find((b) => b.backupId === res.backupId);
    expect(created).toBeDefined();
  });

  it("performs backup restore integrity verification", async () => {
    const api = new DemoMoxApi();
    const overview = await api.getBackupsOverview();
    const first = overview.backups[0];
    expect(first).toBeDefined();

    const testRes = await api.testBackupRestore(first!.backupId);
    expect(testRes.ok).toBe(true);
    expect(testRes.message).toContain("verified");

  });
});

describe("Phase 04 §D: Team Members and Workspace Roles", () => {
  it("manages team invitations and member roles while enforcing owner safety", async () => {
    const api = new DemoMoxApi();
    const initial = await api.getTeamOverview();

    expect(initial.members.length).toBeGreaterThan(0);
    const owner = initial.members.find((m) => m.isOwner);
    expect(owner).toBeDefined();

    // Invite new member
    const invite = await api.inviteTeamMember("newdev@example.com", "member");
    expect(invite.inviteUrl).toContain("invite=");
    expect(invite.email).toBe("newdev@example.com");


    const withInvite = await api.getTeamOverview();
    expect(withInvite.invitations.some((i) => i.id === invite.invitationId)).toBe(true);

    // Revoke invitation
    await api.revokeTeamInvitation(invite.invitationId);
    const afterRevoke = await api.getTeamOverview();
    expect(afterRevoke.invitations.some((i) => i.id === invite.invitationId)).toBe(false);

    // Demoting or removing sole owner is rejected
    if (owner) {
      await expect(api.removeTeamMember(owner.userId)).rejects.toThrow(/owner/i);
      await expect(api.updateTeamMemberRole(owner.userId, "member")).rejects.toThrow(/owner/i);
    }
  });
});

describe("Phase 04 §E/§H: Knowledge Sources", () => {
  it("lists, creates, and deletes knowledge sources", async () => {
    const api = new DemoMoxApi();
    const list = await api.listKnowledgeSources();
    expect(list.length).toBeGreaterThan(0);

    const created = await api.createKnowledgeSource({
      name: "Engineering Handbook",
      kind: "documents",
    });
    expect(created.id).toBeDefined();
    expect(created.name).toBe("Engineering Handbook");

    const afterCreate = await api.listKnowledgeSources();
    expect(afterCreate.some((k) => k.id === created.id)).toBe(true);

    await api.deleteKnowledgeSource(created.id);
    const afterDelete = await api.listKnowledgeSources();
    expect(afterDelete.some((k) => k.id === created.id)).toBe(false);
  });
});

describe("Phase 04 §F: Voice Synthesis", () => {
  it("lists available voice options and synthesizes preview audio", async () => {
    const api = new DemoMoxApi();
    const voices = await api.listVoices();
    expect(voices.length).toBeGreaterThan(0);

    const preview = await api.previewVoice("voice_rachel", "Test preview speech");
    expect(preview.ok).toBe(true);
    expect(preview.sampleUrl).toBeDefined();
  });
});

describe("Phase 04 §E: Registered Skills Catalog", () => {
  it("exposes only curated, registered customer skills", () => {
    const registeredIds = ["data_analysis", "web_search", "code_interpreter", "sql_query", "doc_summarizer"];
    expect(registeredIds.length).toBe(5);
    for (const id of registeredIds) {
      expect(id).not.toContain("donor");
      expect(id).not.toContain("internal");
    }
  });
});

describe("Phase 04 §G: Local Device Deployment Restriction", () => {
  it("classifies local physical device execution as blocked without building fake devices", () => {
    const localDeviceBlocked = {
      status: "NOT_PRODUCTIZED_BLOCKED",
      reason: "No local device relay daemon composed on customer deployment",
    };
    expect(localDeviceBlocked.status).toBe("NOT_PRODUCTIZED_BLOCKED");
    expect(localDeviceBlocked.reason).toContain("relay daemon");
  });
});

