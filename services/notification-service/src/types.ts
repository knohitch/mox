/**
 * Notification service (Prompt 12): centralized routing of canonical
 * platform events to in-app, email, push-ready, SMS-ready, WhatsApp-ready
 * and webhook channels. No service sends email independently.
 */

export type PlatformEventType =
  | "server.ordered"
  | "server.provisioned"
  | "server.provision_failed"
  | "agent.deployed"
  | "agent.crashed"
  | "approval.requested"
  | "subscription.renewed"
  | "subscription.past_due"
  | "subscription.suspended"
  | "backup.completed"
  | "backup.failed"
  | "abuse.case_opened"
  | "provider.incident"
  | "team.invited";

export type Severity = "info" | "warning" | "critical";

export type RouteKind = "in_app" | "email" | "web_push" | "sms" | "whatsapp" | "webhook";

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
  userId?: string;
  eventType: PlatformEventType;
  severity: Severity;
  title: string;
  body: string;
  resourceType?: string;
  resourceId?: string;
  /** Dedupe key: identical events collapse into one notification. */
  dedupeKey?: string;
  readAt?: string;
  archivedAt?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface DispatchedMessage {
  id: string;
  orgId: string;
  userId?: string;
  eventType: PlatformEventType;
  route: Exclude<RouteKind, "in_app">;
  recipient: string;
  title: string;
  body: string;
  at: string;
}

/** A canonical platform event emitted by any Mox service. */
export interface PlatformEvent {
  eventId: string;
  type: PlatformEventType;
  orgId: string;
  userId?: string;
  severity: Severity;
  resourceType?: string;
  resourceId?: string;
  templateVars: Record<string, string>;
  at: string;
}
