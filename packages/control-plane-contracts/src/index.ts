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

/** POST /api/auth/session — exchange a bootstrap credential for a session. */
export interface CreateSessionRequest {
  bootstrapToken: string;
}
export interface CreateSessionResponse {
  sessionToken: string;
  expiresAt: string;
  identity: SessionIdentity;
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
