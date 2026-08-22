/**
 * Notification persistence + outbound route transports.
 */

import type {
  DispatchedMessage,
  InAppNotification,
  MessageTemplate,
  NotificationPreferences,
} from "./types.js";

export interface NotificationStore {
  upsertPreferences(prefs: NotificationPreferences): Promise<void>;
  getPreferences(orgId: string, userId?: string): Promise<NotificationPreferences | undefined>;

  putTemplate(template: MessageTemplate): Promise<void>;
  getTemplate(eventType: string, locale: string): Promise<MessageTemplate | undefined>;

  /** Returns the existing notification when dedupeKey already seen. */
  insert(notification: InAppNotification): Promise<{ created: boolean; existing?: InAppNotification }>;
  get(id: string): Promise<InAppNotification | undefined>;
  list(orgId: string, options?: { unreadOnly?: boolean; includeArchived?: boolean }): Promise<InAppNotification[]>;
  markRead(id: string, at: string): Promise<void>;
  archive(id: string, at: string): Promise<void>;
  purgeExpired(nowIso: string): Promise<number>;

  recordDispatch(message: DispatchedMessage): Promise<void>;
  listDispatches(orgId: string): Promise<DispatchedMessage[]>;
}

export class InMemoryNotificationStore implements NotificationStore {
  private readonly prefs = new Map<string, NotificationPreferences>();
  private readonly templates = new Map<string, MessageTemplate>();
  private readonly notifications = new Map<string, InAppNotification>();
  private readonly dedupeIndex = new Map<string, string>();
  private readonly dispatches = new Map<string, DispatchedMessage[]>();

  async upsertPreferences(prefs: NotificationPreferences): Promise<void> {
    this.prefs.set(`${prefs.orgId}:${prefs.userId ?? "*"}`, prefs);
  }

  async getPreferences(orgId: string, userId?: string): Promise<NotificationPreferences | undefined> {
    return this.prefs.get(`${orgId}:${userId ?? "*"}`);
  }

  async putTemplate(template: MessageTemplate): Promise<void> {
    this.templates.set(`${template.eventType}:${template.locale}`, template);
  }

  async getTemplate(eventType: string, locale: string): Promise<MessageTemplate | undefined> {
    return this.templates.get(`${eventType}:${locale}`);
  }

  async insert(notification: InAppNotification): Promise<{ created: boolean; existing?: InAppNotification }> {
    if (notification.dedupeKey) {
      const existingId = this.dedupeIndex.get(`${notification.orgId}:${notification.dedupeKey}`);
      if (existingId) {
        return { created: false, existing: this.notifications.get(existingId) };
      }
      this.dedupeIndex.set(`${notification.orgId}:${notification.dedupeKey}`, notification.id);
    }
    this.notifications.set(notification.id, notification);
    return { created: true };
  }

  async get(id: string): Promise<InAppNotification | undefined> {
    return this.notifications.get(id);
  }

  async list(orgId: string, options?: { unreadOnly?: boolean; includeArchived?: boolean }): Promise<InAppNotification[]> {
    return [...this.notifications.values()]
      .filter((n) => n.orgId === orgId)
      .filter((n) => (options?.unreadOnly ? !n.readAt : true))
      .filter((n) => (options?.includeArchived ? true : !n.archivedAt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async markRead(id: string, at: string): Promise<void> {
    const n = this.notifications.get(id);
    if (n) n.readAt = at;
  }

  async archive(id: string, at: string): Promise<void> {
    const n = this.notifications.get(id);
    if (n) n.archivedAt = at;
  }

  async purgeExpired(nowIso: string): Promise<number> {
    let purged = 0;
    for (const [id, n] of this.notifications.entries()) {
      if (n.expiresAt && n.expiresAt <= nowIso) {
        this.notifications.delete(id);
        purged += 1;
      }
    }
    return purged;
  }

  async recordDispatch(message: DispatchedMessage): Promise<void> {
    const list = this.dispatches.get(message.orgId) ?? [];
    list.push(message);
    this.dispatches.set(message.orgId, list);
  }

  async listDispatches(orgId: string): Promise<DispatchedMessage[]> {
    return [...(this.dispatches.get(orgId) ?? [])];
  }
}

/** Outbound transport seam for every non-in-app route. */
export interface RouteTransport {
  readonly kind: "email" | "web_push" | "sms" | "whatsapp" | "webhook";
  send(message: DispatchedMessage): Promise<{ delivered: boolean; error?: string }>;
}
