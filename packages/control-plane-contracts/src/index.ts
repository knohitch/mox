/**
 * Wire contracts between the Mox web client and the Mox Control Plane HTTP
 * API (Prompt 00 §A). Shared by `apps/web` (client) and
 * `services/control-plane` (server) so the authenticated API path is typed
 * end to end. Pure types only — no runtime dependencies.
 */

export interface ApiErrorBody {
  error: string;
  code?: string;
  /** True when the control plane is reachable but a dependency is down. */
  unavailable?: boolean;
}

/** GET /api/me — authenticated identity supplied by the server. */
export interface SessionIdentity {
  userId: string;
  email: string;
  displayName: string;
  orgId: string;
  orgSlug: string;
  orgDisplayName: string;
  role: string;
}

/** GET /api/me — full authenticated context including org memberships. */
export interface MeResponse extends SessionIdentity {
  orgs: Array<{ orgId: string; slug: string; displayName: string; role: string }>;
}

/**
 * POST /api/auth/login | /api/auth/signup | /api/auth/orgs/select — the
 * BROWSER auth contract (Prompt 00C §A). Identity + expiry metadata only:
 * the reusable session credential travels exclusively in the HttpOnly
 * cookie and can NEVER appear in this JSON.
 */
export type BrowserAuthResponse = MeResponse & { expiresAt: string };

/**
 * POST /api/auth/token-login — the PROGRAMMATIC LOGIN contract (00C §B /
 * 00D §C): the only password→bearer exchange. Returns identity context plus
 * the freshly minted personal access token (shown once).
 */
export interface ProgrammaticLoginResponse extends MeResponse {
  token: string;
  tokenId: string;
  scopes: string[];
  expiresAt: string;
}

/**
 * POST /api/auth/tokens — creation metadata only (00D §C). Session-auth
 * only; the plaintext is shown exactly once and never stored server-side.
 */
export interface CreateApiTokenResponse {
  token: string;
  tokenId: string;
  scopes: string[];
  expiresAt: string;
}

/** GET /api/auth/tokens — metadata only, never a plaintext token. */
export interface ApiTokenMetadata {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  /** Safe, server-validated return target carried through the login cookie set. */
  returnTo?: string;
}
export interface SignupRequest {
  email: string;
  password: string;
  displayName?: string;
  orgName?: string;
}

/** POST /api/admin/signup | /api/support/signup — invite-first staff signup. */
export interface StaffSignupRequest {
  email: string;
  password: string;
  inviteToken: string;
  displayName?: string;
}

export interface StaffLoginRequest extends LoginRequest {
  returnTo?: string;
}

/** POST /api/auth/token-login request (programmatic contract, 00C §B). */
export interface TokenLoginRequest extends LoginRequest {
  name?: string;
  scopes?: string[];
}

/** POST /api/auth/orgs/select — membership-verified active-org switch. */
export interface SelectOrgRequest {
  orgId: string;
}

/**
 * Admin / support staff surface identity (Prompt 01). Distinct from customer
 * identity (`SessionIdentity`): staff authenticate into an isolated surface
 * via cookie sessions that never overlap the customer browser session.
 */
export interface StaffSessionIdentity {
  staffUserId: string;
  email: string;
  displayName: string;
  surface: "admin" | "support";
  role: string;
  capabilities: string[];
}

/**
 * GET /api/admin/session | /api/support/session — active staff surface
 * session. The durable credential rides the HttpOnly cookie; this JSON is
 * identity + capability metadata only.
 *
 * NOTE: the two surfaces return slightly different shapes:
 *  - Admin  session -> `role` (string), `capabilities`, `staffRoles`
 *  - Support session -> `roles` (string[]), `capabilities`
 * Both are normalized here onto one type; login responses additionally carry
 * the full BrowserAuth identity (`staffUserId`/`email`/`displayName`).
 */
export interface StaffSessionResponse {
  staffUserId?: string;
  email?: string;
  displayName?: string;
  surface?: "admin" | "support";
  /** Admin surface: primary role. */
  role?: string;
  /** Support surface: all granted support roles. */
  roles?: string[];
  /** Admin surface: all granted staff roles. */
  staffRoles?: string[];
  capabilities: string[];
  grants?: Array<{ surface: "admin" | "support"; role: string; capabilities: string[] }>;
}

/**
 * POST /api/admin/login | /api/support/login — staff browser login. Never
 * returns a reusable credential; only identity metadata + cookie expiry. The
 * server-validated `returnTo` (kept within this staff surface) is echoed back
 * so the client can continue the journey without trusting a raw query string.
 */
export type StaffLoginResponse = StaffSessionResponse & { expiresAt: string; returnTo: string };

/**
 * POST /api/auth/forgot-password — anti-enumeration result envelope.
 * `deliverableToken` is populated ONLY when no email transport is registered
 * (fail-closed delivery): it is a short-lived, single-use reset token that a
 * bootstrap/self-serve deployment can surface to the requesting operator.
 */
export interface ForgotPasswordResponse {
  ok: boolean;
  deliverableToken?: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

/**
 * POST /api/admin/staff/invites — staff invites (admin surface). Invitee
 * consumes the one-time `inviteToken` at signup.
 */
export interface CreateStaffInviteResponse {
  invitationId: string;
  surface: "admin" | "support" | "both";
  role: string;
  email: string;
  token: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface StaffInviteRow {
  invitationId: string;
  surface: "admin" | "support" | "both";
  role: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

/**
 * Prompt 03 Staff & Access — a durable platform-staff membership row, as
 * returned by GET /api/admin/staff. Read/managed only by `admin.staff.write`.
 */
export interface StaffMembershipRow {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  surface: "admin" | "support";
  enabled: boolean;
  grantedByUserId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface AdminStaffList {
  members: StaffMembershipRow[];
  invites: StaffInviteRow[];
}

/**
 * Prompt 03 Support — least-privilege support-safe projections. Deliberately
 * EXCLUDE costs, margins, provider credentials, IPs/hostnames and root
 * credential refs.
 */
export interface SupportCustomerSummary {
  orgId: string;
  slug: string;
  displayName: string;
  workspaceName: string | null;
  createdAt: string;
  memberCount: number;
  users: Array<{ userId: string; email: string; displayName: string; role: string; disabledAt: string | null }>;
  subscriptions: SupportSubscriptionLifecycle[];
  servers: SupportServerDiagnostic[];
  agents: SupportAgentDiagnostic[];
  supportNoteCount: number;
  diagnostics: SupportDiagnosticSummary;
}

export interface SupportCustomerList {
  customers: SupportCustomerSummary[];
}

export interface SupportCustomerDetail extends SupportCustomerSummary {
  supportNotes: Array<{ id: string; actorId: string | null; note: string; at: string }>;
  recentActivity: Array<{ id: string; action: string; at: string; actorType: string; resourceType: string | null }>;
  connections: SupportConnectionDiagnostics;
  notificationFailures: SupportNotificationFailure[];
}

export interface SupportNoteRequest {
  note: string;
}

export interface SupportDiagnosticSummary {
  subscriptionsRequiringAttention: number;
  serversInError: number;
  nodesStaleOrMissing: number;
  agentsDegraded: number;
  connectionsConfigured: number;
  connectionsTotal: number;
  recentNotificationFailures: number;
}

export interface SupportSubscriptionLifecycle {
  subscriptionId: string;
  state: string;
  plan: string;
  tier: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  retentionUntil: string | null;
  failedRenewals: number;
  cancelAtPeriodEnd: boolean;
  suspensionReason: string | null;
  reconciliationRequired: boolean;
}

export interface SupportServerDiagnostic {
  id: string;
  orgId: string;
  computeClassCode: string;
  state: string;
  providerName: string | null;
  regionCode: string | null;
  lifecycle: { state: string; attemptCount: number; errorSummary: string | null };
  nodeHealth?: { status: string; version: string | null; lastSeenAt: string | null; health: string };
  createdAt: string;
  updatedAt: string;
}

export interface SupportAgentDiagnostic {
  agentId: string;
  slug: string;
  displayName: string;
  status: string;
  currentVersion?: number;
  deploymentKind?: string;
  deploymentState?: string;
  desiredRevision?: number;
  runtimeHealth?: string;
}

export interface SupportConnectionDiagnostics {
  models: Array<{ providerId: string; displayName: string; kind: string; status: string; credentialConfigured: boolean; connected: boolean }>;
  integrations: Array<{ integrationId: string; displayName: string; kind: string; status: string; credentialConfigured: boolean; connected: boolean }>;
  channels: Array<{
    channelId: string;
    displayName: string;
    kind: string;
    status: string;
    credentialConfigured: boolean;
    connected: boolean;
    boundAgentId: string | null;
    boundAgentName: string | null;
  }>;
}

export interface SupportNotificationFailure {
  id: string;
  eventType: string;
  route: string;
  deliveryState: string;
  attempts: number;
  errorSummary: string | null;
  at: string;
}

/**
 * POST /api/setup/bootstrap — one-time platform owner provisioning.
 * Requires the server-side deployment setup credential; permanently closed
 * after completion. Never a login path.
 */
export interface SetupBootstrapRequest {
  setupToken: string;
  ownerEmail: string;
  ownerPassword: string;
  orgSlug: string;
  orgDisplayName?: string;
}

/** POST /node/enroll — first-time Mox Node enrollment (Prompt 00 §E). */
export interface NodeEnrollRequest {
  nodeId: string;
  version?: string;
  capabilities?: readonly string[];
}
export interface NodeEnrollResponse {
  nodeId: string;
  orgId: string;
  orderId: string;
  agentToken: string;
}

/** POST /api/threads/:threadId/messages — submit a user turn. */
export interface SendMessageRequest {
  text: string;
  roomId?: string;
}

/** SSE stream envelope used by GET /api/streams/org-events. */
export interface OrgEventFrame {
  seq: number;
  event: unknown;
}

/**
 * Header the control plane requires on cookie-authenticated mutations
 * (CSRF defense). Non-browser bearer clients may send it too.
 */
export const CSRF_HEADER = "x-mox-csrf";
