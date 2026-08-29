/** Human-readable UI labels for camelCase / snake_case schema keys. */

const LABEL_OVERRIDES: Record<string, string> = {
  providerName: "Provider",
  accountLabel: "Account",
  computeClassCode: "Compute class",
  regionCode: "Region",
  orgId: "Workspace ID",
  agentId: "Agent",
  displayName: "Name",
  currentPeriodEnd: "Period end",
  currentPeriodStart: "Period start",
  failedRenewals: "Failed renewals",
  suspensionReason: "Suspension",
  reconciliationRequired: "Needs reconciliation",
  nodeHealth: "Node health",
  runtimeHealth: "Runtime",
  boundAgentName: "Bound agent",
  credentialConfigured: "Credential",
  audienceType: "Audience",
  fanoutDone: "Sent",
  fanoutTotal: "Audience size",
  eventType: "Event",
  deliveryState: "Delivery",
  errorSummary: "Error",
  actorType: "Actor",
  resourceType: "Resource",
  actorId: "Author",
  createdAt: "Created",
  updatedAt: "Updated",
  workspaceName: "Workspace",
  supportNoteCount: "Notes",
  disabledAt: "Disabled",
  currentVersion: "Version",
  deploymentKind: "Kind",
  deploymentState: "Deployment",
  desiredRevision: "Desired revision",
  commercialStatus: "Commercial status",
};

export function humanizeLabel(key: string): string {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
