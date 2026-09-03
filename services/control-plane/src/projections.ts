import { createHash } from "node:crypto";

export type ServerState =
  | "requested"
  | "provisioning"
  | "running"
  | "error"
  | "resizing"
  | "stopping"
  | "stopped"
  | "cancelling"
  | "canceled"
  | "retention"
  | "destroyed";

export type DeploymentKind = "sandbox" | "shared_host" | "dedicated_vps" | "customer_vps";

export type DeploymentState = "desired" | "provisioning" | "running" | "degraded" | "stopped" | "failed";

export function projectDeploymentState(
  orderState: ServerState | undefined,
  heartbeatAt: string | undefined,
): DeploymentState {
  if (!orderState) return "desired";
  switch (orderState) {
    case "running":
      return heartbeatAt ? "running" : "degraded";
    case "requested":
    case "provisioning":
    case "resizing":
    case "cancelling":
      return "provisioning";
    case "stopping":
    case "stopped":
    case "canceled":
    case "retention":
    case "destroyed":
      return "stopped";
    case "error":
      return "failed";
    default:
      return "desired";
  }
}

export function projectDeploymentTarget(
  kind: DeploymentKind,
  orderId: string | undefined,
): { kind: string; vpsId?: string; region?: string } {
  switch (kind) {
    case "sandbox":
      return { kind: "sandbox" };
    case "customer_vps":
      return { kind: "customer-vps", vpsId: orderId ?? "" };
    case "shared_host":
    case "dedicated_vps":
    default:
      return { kind: "mox-cloud" };
  }
}

export function deploymentVersionId(agentId: string | undefined, desiredRevision: number): string {
  return `${agentId ?? "unknown"}@${desiredRevision}`;
}

export type ModelAvailability = { state: "available" | "not_configured" | "error"; reason?: string };

export function projectModelAvailability(status: string, hasCreds: boolean): ModelAvailability {
  if (!hasCreds) {
    return { state: "not_configured", reason: "no provider credentials connected" };
  }
  switch (status) {
    case "configured":
      return { state: "available" };
    case "error":
      return { state: "error", reason: "provider connection error" };
    case "disabled":
    case "unconfigured":
    default:
      return { state: "not_configured", reason: status };
  }
}

export interface ServerOrderView {
  providerInstanceId?: string | null;
  id: string;
  hostname: string;
  computeClassCode?: string | null;
  regionCode?: string | null;
  state: ServerState;
  providerName?: string | null;
  lastError?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ServerSummaryView {
  serverId: string;
  orderId: string;
  displayName: string;
  kind: "customer-vps";
  computeClass: string | null;
  region: string;
  state: ServerState;
  agentsRunning: null;
  cpuPct: null;
  memPct: null;
  lastError: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export function projectServerSummary(order: ServerOrderView): ServerSummaryView {
  return {
    serverId: order.providerInstanceId ?? order.id,
    orderId: order.id,
    displayName: order.hostname,
    kind: "customer-vps",
    computeClass: order.computeClassCode ?? null,
    region: order.regionCode ?? "unknown",
    state: order.state,
    agentsRunning: null,
    cpuPct: null,
    memPct: null,
    lastError: order.lastError ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

// ---- Customer provisioning (PRODUCT_COMPLETION_02) ----------------------------

/** Customer-safe SSH public-key projection. Public material only, by design. */
export interface SshKeyView {
  id: string;
  label: string;
  fingerprint: string;
  publicKey: string;
  createdAt: Date | string;
}

interface SshKeyRowLike {
  id: string;
  label: string;
  fingerprint: string;
  publicKey: string;
  createdAt: Date | string;
}

export function projectSshKey(row: SshKeyRowLike): SshKeyView {
  return {
    id: row.id,
    label: row.label,
    fingerprint: row.fingerprint,
    publicKey: row.publicKey,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

const SSH_PUBLIC_KEY_ALGO_RE =
  /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

/**
 * Validates an OpenSSH-format PUBLIC key ("algo base64 [comment]") and returns
 * its SHA256 fingerprint (OpenSSH style). Anything that looks like a private
 * key, a hostile multi-line blob, or fails to decode is rejected — the
 * Control Plane never persists private key material.
 */
export function parseSshPublicKey(input: string): { ok: true; fingerprint: string; algo: string } | { ok: false; error: string } {
  const value = input.trim();
  if (!value || value.length > 8192) return { ok: false, error: "public key is required (max 8192 characters)" };
  if (value.includes("\n") || /PRIVATE KEY/i.test(value)) {
    return { ok: false, error: "exactly one public key line is required — never paste a private key" };
  }
  const parts = value.split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return { ok: false, error: "public key must look like: <algorithm> <base64> [comment]" };
  const [algo, b64] = [parts[0]!, parts[1]!];
  if (!SSH_PUBLIC_KEY_ALGO_RE.test(algo)) return { ok: false, error: `unsupported public key algorithm: ${algo}` };
  if (b64.length < 16 || b64.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { ok: false, error: "public key body is not valid base64" };
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(b64, "base64");
  } catch {
    return { ok: false, error: "public key body is not valid base64" };
  }
  if (decoded.length < 8 || Buffer.from(b64, "base64").toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
    return { ok: false, error: "public key body is not valid base64" };
  }
  const fingerprint = `SHA256:${createHash("sha256").update(decoded).digest("base64").replace(/=+$/, "")}`;
  return { ok: true, fingerprint, algo };
}

export interface SupportServerOrderView {
  id: string;
  orgId: string;
  computeClassCode: string;
  state: ServerState;
  providerName?: string | null;
  regionCode?: string | null;
  attemptCount?: number;
  lastError?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface SupportServerProjection {
  id: string;
  orgId: string;
  computeClassCode: string;
  state: ServerState;
  providerName: string | null;
  regionCode: string | null;
  lifecycle: {
    state: ServerState;
    attemptCount: number;
    errorSummary: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export function supportSafeErrorSummary(message: string | null | undefined): string | null {
  if (!message?.trim()) return null;
  const lower = message.toLowerCase();
  if (/\b(timeout|timed out|deadline)\b/.test(lower)) return "operation timed out";
  if (/\b(quota|capacity|limit|insufficient)\b/.test(lower)) return "provider capacity or quota issue";
  if (/\b(auth|permission|unauthorized|forbidden|credential)\b/.test(lower)) return "provider authorization issue";
  if (/\b(rate|429|throttle)\b/.test(lower)) return "provider rate limit issue";
  if (/\b(network|dns|connect|connection)\b/.test(lower)) return "network connectivity issue";
  return "server lifecycle error recorded";
}

export function supportSafeSuspensionReason(reason: string | null | undefined): string | null {
  if (!reason?.trim()) return null;
  const lower = reason.toLowerCase();
  if (/\b(payment|invoice|renewal|past[_ -]?due)\b/.test(lower)) return "payment issue";
  if (/\b(refund|dispute|chargeback)\b/.test(lower)) return "payment reversal review";
  if (/\b(fraud|abuse|risk)\b/.test(lower)) return "trust and safety review";
  if (/\b(compliance|policy|legal)\b/.test(lower)) return "policy review";
  if (/\b(admin|manual|platform)\b/.test(lower)) return "manual platform hold";
  return "subscription hold";
}

export function projectSupportServerOrder(row: SupportServerOrderView): SupportServerProjection {
  return {
    id: row.id,
    orgId: row.orgId,
    computeClassCode: row.computeClassCode,
    state: row.state,
    providerName: row.providerName ?? null,
    regionCode: row.regionCode ?? null,
    lifecycle: {
      state: row.state,
      attemptCount: row.attemptCount ?? 0,
      errorSummary: supportSafeErrorSummary(row.lastError),
    },
    createdAt: isoString(row.createdAt),
    updatedAt: isoString(row.updatedAt),
  };
}

export interface SupportNodeHealthView {
  status?: string | null;
  version?: string | null;
  lastHeartbeatAt?: Date | string | null;
}

export function projectSupportNodeHealth(
  node: SupportNodeHealthView | undefined,
  now: Date = new Date(),
): { status: string; version: string | null; lastSeenAt: string | null; health: "not_enrolled" | "active" | "stale" | "inactive" } {
  if (!node) {
    return { status: "not_enrolled", version: null, lastSeenAt: null, health: "not_enrolled" };
  }
  const status = node.status ?? "unknown";
  const lastSeenAt = node.lastHeartbeatAt ? isoString(node.lastHeartbeatAt) : null;
  const lastSeenMs = node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).getTime() : 0;
  const stale = !lastSeenMs || now.getTime() - lastSeenMs > 15 * 60_000;
  return {
    status,
    version: node.version ?? null,
    lastSeenAt,
    health: status === "active" ? (stale ? "stale" : "active") : "inactive",
  };
}

export const SUPPORT_NOTE_MAX_LENGTH = 4000;

export function validateSupportNoteText(raw: unknown): { ok: true; note: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "note is required" };
  const note = raw.trim();
  if (!note) return { ok: false, reason: "note is required" };
  if (note.length > SUPPORT_NOTE_MAX_LENGTH) {
    return { ok: false, reason: `note must be ${SUPPORT_NOTE_MAX_LENGTH} characters or less` };
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(note)) {
    return { ok: false, reason: "note contains unsupported control characters" };
  }
  if (/<\s*\/?\s*(script|iframe|object|embed|img|svg|math|style|link|meta|base)\b/i.test(note)) {
    return { ok: false, reason: "note must not contain HTML or script content" };
  }
  return { ok: true, note };
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

// ---- Phase 04: Extended Capabilities Projections ----------------------------

export type UsageStatus =
  | "within_included"
  | "soft_limit_warning"
  | "hard_limit_blocked"
  | "unlimited"
  | "overage";

export function projectUsageStatus(
  consumed: number,
  included: number,
  limits?: { hardLimit?: number; softLimit?: number },
): UsageStatus {
  if (included < 0 && limits?.hardLimit === undefined) {
    return "unlimited";
  }
  if (limits?.hardLimit !== undefined && consumed > limits.hardLimit) {
    return "hard_limit_blocked";
  }
  if (limits?.softLimit !== undefined && consumed > limits.softLimit) {
    return "soft_limit_warning";
  }
  if (included >= 0 && consumed > included) {
    return "overage";
  }
  return "within_included";
}

/** Customer-safe backup location descriptor (never leaks s3 credentials or internal bucket paths). */
export function maskBackupLocation(location: string, kind: string): string {
  if (kind === "s3_copy" || location.startsWith("s3://")) {
    return "Mox Cloud Storage";
  }
  if (kind === "provider_snapshot" || location.includes("snapshot")) {
    return "Server Snapshot";
  }
  return "Cloud Storage";
}

/** Owner safety rules for team member mutations. */
export function canMutateMember(params: {
  callerRole: string;
  targetRole: string;
  isOwnerTarget: boolean;
  activeOwnerCount: number;
  action: "demote" | "remove";
}): { allowed: boolean; reason?: string } {
  if (params.isOwnerTarget) {
    if (params.callerRole !== "owner") {
      return { allowed: false, reason: "only workspace owners can modify owner memberships" };
    }
    if (params.activeOwnerCount <= 1) {
      return { allowed: false, reason: "cannot demote or remove the only remaining workspace owner" };
    }
  }
  return { allowed: true };
}

/** Validates schedule count against schedule_workflow_limit entitlement. */
export function validateScheduleLimit(
  schedulesCount: number,
  limit: number,
): { allowed: boolean; reason?: string } {
  if (limit >= 0 && schedulesCount > limit) {
    return { allowed: false, reason: `schedules count (${schedulesCount}) exceeds entitlement limit (${limit})` };
  }
  return { allowed: true };
}

/** Validates subagent delegation refs to prevent self-reference cycles. */
export function validateSubagents(
  subagents: Array<{ agentId: string }>,
  currentAgentId: string,
  currentSlug?: string,
): { valid: boolean; reason?: string } {
  for (const sub of subagents) {
    if (sub.agentId === currentAgentId || (currentSlug && sub.agentId === currentSlug)) {
      return { valid: false, reason: "subagent cannot self-reference the agent itself" };
    }
  }
  return { valid: true };
}

/** Validates knowledge access permissions. */
export function validateKnowledgeAccess(
  access: string[],
): { valid: boolean; reason?: string } {
  if (!access || access.length === 0) {
    return { valid: false, reason: "at least one access permission is required" };
  }
  const allowed = new Set(["read", "search", "attach"]);
  for (const a of access) {
    if (!allowed.has(a)) {
      return { valid: false, reason: `invalid knowledge access permission: ${a}` };
    }
  }
  return { valid: true };
}
