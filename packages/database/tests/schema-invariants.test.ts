import { describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.js";

/**
 * Structural invariants: every tenant-owned table carries an orgId column
 * so tenant scoping can be enforced uniformly.
 */

const TENANT_TABLES = [
  "memberships",
  "membershipPermissions",
  "agents",
  "agentVersions",
  "agentDeployments",
  "agentRooms",
  "roomMembers",
  "skills",
  "agentSkills",
  "knowledgeSources",
  "threads",
  "sessionEventMeta",
  "runtimeRuns",
  "toolCalls",
  "approvalRequests",
  "jobs",
  "modelProviders",
  "models",
  "modelConnections",
  "credentialRefs",
  "customerCredentialSecrets",
  "modelUsageRefs",
  "computers",
  "computerSessions",
  "computerPolicies",
  "computerActions",
  "integrationProviders",
  "integrationConnections",
  "toolGrants",
  "channelProviders",
  "channelConnections",
  "externalConversations",
  "channelMessages",
  "auditEvents",
  "usageEvents",
  "costEvents",
  "computeInstances",
  "notifications",
  "backups",
  "abuseCases",
  "featureFlags",
] as const;

describe("schema invariants", () => {
  it("exports every tenant-owned table with an orgId column", () => {
    for (const name of TENANT_TABLES) {
      const table = (schema as Record<string, unknown>)[name];
      expect(table, `missing table export: ${name}`).toBeTruthy();
      const cols = (table as Record<string, { name?: string }>);
      expect(cols.orgId, `${name} must have an orgId column`).toBeTruthy();
    }
  });

  it("keeps global tables free of orgId", () => {
    for (const name of ["users", "organizations", "authSessions", "externalIdentities"] as const) {
      const table = (schema as unknown as Record<string, Record<string, unknown> | undefined>)[name];
      expect(table, `missing table export: ${name}`).toBeTruthy();
      expect(table?.orgId, `${name} must not carry orgId`).toBeUndefined();
    }
  });

  it("keeps Mox-system credential/provider tables free of orgId", () => {
    for (const name of [
      "systemCredentialRefs",
      "systemCredentialSecrets",
      "systemModelProviders",
      "systemModels",
      "systemModelConnections",
    ] as const) {
      const table = (schema as unknown as Record<string, Record<string, unknown> | undefined>)[name];
      expect(table, `missing system table export: ${name}`).toBeTruthy();
      expect(table?.orgId, `${name} must not carry orgId`).toBeUndefined();
    }
  });
});
