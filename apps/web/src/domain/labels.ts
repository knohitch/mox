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

function primitiveDisplay(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.length === 0 ? "none" : `${value.length} items`;
  if (typeof value === "object") return "details available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Human-readable cell value for normal UI tables; never exposes raw JSON. */
export function formatDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return value.map(primitiveDisplay).filter(Boolean).join(", ");
    }
    return `${value.length} items`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== null && entryValue !== undefined && entryValue !== "")
      .slice(0, 4);
    if (entries.length === 0) return "";
    const summary = entries
      .map(([key, entryValue]) => `${humanizeLabel(key)}: ${primitiveDisplay(entryValue)}`)
      .join(" · ");
    const suffix = Object.keys(value as Record<string, unknown>).length > entries.length ? " · more" : "";
    return `${summary}${suffix}`;
  }
  return primitiveDisplay(value);
}
