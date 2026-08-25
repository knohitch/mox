/**
 * Notification domain (Prompt 02): durable in-app inbox plus admin
 * draft/send/schedule/broadcast machinery. Security model:
 * - user operations are ALWAYS scoped by authenticated (orgId, userId);
 * - a user can never read/mutate/enumerate another user's notifications;
 * - admin send/broadcast requires REAL platform/staff authority upstream
 *   and is audited; PAT scopes never confer it.
 */

export type PlatformEventType =
  | "server.ordered"
  | "server.provisioned"
  | "server.provision_failed"
  | "agent.deployed"
  | "agent.crashed"
  | "approval.requested"
  | "subscription.activated"
  | "subscription.canceled"
  | "subscription.renewed"
  | "subscription.past_due"
  | "subscription.suspended"
  | "node.offline"
  | "backup.completed"
  | "backup.failed"
  | "abuse.case_opened"
  | "provider.incident"
  | "team.invited";

/** Inbox filter categories (UI tabs). */
export type NotificationCategory = "system" | "billing" | "servers" | "agents" | "security";

export type Severity = "info" | "warning" | "critical";

export type RouteKind = "in_app" | "email" | "web_push" | "sms" | "whatsapp" | "webhook";

export type AudienceType = "user" | "users" | "org" | "plan" | "region" | "all";

export interface NotificationPreferences {
  orgId: string;
  userId?: string;
  /** Per-event-type route overrides; absent keys fall back to defaults. */
  routes: Partial<Record<PlatformEventType, RouteKind[]>>;
  mutedEventTypes: PlatformEventType[];
}

export interface MessageTemplate {
  eventType: PlatformEventType;
  locale: string;
  title: string;
  body: string;
}

export interface InAppNotification {
  id: string;
  orgId: string;
  /** Targeted recipient; null for org/broadcast audience rows. */
  userId?: string;
  eventType: PlatformEventType | `admin.${string}`;
  severity: Severity;
  title: string;
  body: string;
  audienceType: AudienceType;
  category: NotificationCategory;
  createdBy?: string;
  resourceType?: string;
  resourceId?: string;
  /** Dedupe key: identical events collapse into one notification. */
  dedupeKey?: string;
  scheduledAt?: string;
  deliveryState: "draft" | "scheduled" | "ready" | "sent" | "failed";
  readAt?: string;
  archivedAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type DispatchState = "pending" | "sending" | "sent" | "failed" | "uncertain";

export interface DispatchedMessage {
  id: string;
  orgId: string;
  userId?: string;
  eventType: PlatformEventType;
  route: Exclude<RouteKind, "in_app">;
  recipient: string;
  title: string;
  body: string;
  dedupeKey?: string;
  at: string;
  /**
   * Security Repair 05B §K: durable dispatch outbox state.
   * pending → sending → sent | failed | uncertain. A crash between the
   * transport send and the durable terminal record leaves `sending`, which
   * the sweep surfaces as `uncertain` — never silently resent unless the
   * transport guarantees provider-side idempotency.
   */
  deliveryState?: DispatchState;
  attempts?: number;
  lastError?: string;
}

/** A canonical platform event emitted by any Mox service. */
export interface PlatformEvent {
  eventId: string;
  type: PlatformEventType;
  orgId: string;
  userId?: string;
  severity: Severity;
  category?: NotificationCategory;
  resourceType?: string;
  resourceId?: string;
  templateVars: Record<string, string>;
  at: string;
}

// ---- Admin authoring (Prompt 02) ----------------------------------------------

export interface AdminNotificationPayload {
  title: string;
  body: string;
  severity?: Severity;
  category?: NotificationCategory;
  resourceType?: string;
  resourceId?: string;
  expiresAt?: string;
}

export interface AdminAudience {
  type: AudienceType;
  /** For type=user|users: explicit recipients. */
  userIds?: string[];
  /** For type=org: workspace scope. */
  orgId?: string;
  /** For type=plan: product tier segment. */
  planTier?: string;
  /** For type=region: pricing/billing region code. */
  regionCode?: string;
}

export interface AdminSendInput {
  idempotencyKey: string;
  createdBy: string;
  audience: AdminAudience;
  payload: AdminNotificationPayload;
  scheduledAt?: string;
}

export interface NotificationJobRecord {
  id: string;
  orgId?: string;
  audienceType: AudienceType;
  audiencePayload: Record<string, unknown>;
  title: string;
  body: string;
  severity: Severity;
  category: NotificationCategory;
  resourceType?: string;
  resourceId?: string;
  status: "draft" | "scheduled" | "running" | "completed" | "canceled" | "failed";
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  fanoutTotal: number;
  fanoutDone: number;
  attempts: number;
  claimOwner?: string;
  claimExpiresAt?: string;
  /** Security Repair 05B §A: fencing token set by every job claim. */
  claimVersion?: number;
  error?: string;
  createdBy: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}
