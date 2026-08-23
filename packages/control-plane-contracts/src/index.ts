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
 * POST /api/auth/login | /api/auth/signup — session establishment. The
 * session token rides an HttpOnly cookie; `sessionToken` is additionally
 * returned for non-browser clients (CLI, Mox Node tooling) and must never
 * be persisted by browsers.
 */
export interface AuthSessionResponse extends MeResponse {
  sessionToken: string;
  expiresAt: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}
export interface SignupRequest {
  email: string;
  password: string;
  displayName?: string;
  orgName?: string;
}

/** POST /api/auth/orgs/select — membership-verified active-org switch. */
export interface SelectOrgRequest {
  orgId: string;
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
 * Standard header the control plane requires on every authenticated call.
 * Bearer <sessionToken>.
 */
export const SESSION_AUTH_HEADER = "authorization";
