/**
 * Notification persistence + outbound route transports (Prompt 02).
 *
 * User-facing reads are OWNERSHIP-SCOPED by contract: every method that
 * touches a single notification takes the authenticated userId and refuses
 * rows targeted to someone else. Org/broadcast audience rows are visible to
 * every member of the org; user-targeted rows only to their recipient.
 */

import type {
  AdminAudience,
  AdminSendInput,
  DispatchedMessage,
  InAppNotification,
  MessageTemplate,
  NotificationJobRecord,
  NotificationPreferences,
} from "./types.js";

export interface UserInboxFilters {
  unreadOnly?: boolean;
  includeArchived?: boolean;
  category?: string;
  limit?: number;
  offset?: number;
}

export interface NotificationStore {
  upsertPreferences(prefs: NotificationPreferences): Promise<void>;
  getPreferences(orgId: string, userId?: string): Promise<NotificationPreferences | undefined>;

  putTemplate(template: MessageTemplate): Promise<void>;
  getTemplate(eventType: string, locale: string): Promise<MessageTemplate | undefined>;

  /** Returns the existing notification when dedupeKey already seen. */
  insert(notification: InAppNotification): Promise<{ created: boolean; existing?: InAppNotification }>;
  /** Ownership-checked single fetch (Prompt 02 §Security). */
  getForUser(id: string, orgId: string, userId: string): Promise<InAppNotification | undefined>;
  /** Inbox listing scoped to one user inside one org. */
  /** userId optional: omit to list only org/broadcast rows. */
  listForUser(orgId: string, userId?: string, filters?: UserInboxFilters): Promise<InAppNotification[]>;
  unreadCount(orgId: string, userId: string): Promise<number>;
  markRead(id: string, orgId: string, userId: string, at: string): Promise<boolean>;
  markUnread(id: string, orgId: string, userId: string, at: string): Promise<boolean>;
  markAllRead(orgId: string, userId: string, at: string): Promise<number>;
  archive(id: string, orgId: string, userId: string, at: string): Promise<boolean>;
  purgeExpired(nowIso: string): Promise<number>;

  recordDispatch(message: DispatchedMessage): Promise<void>;
  listDispatches(orgId: string): Promise<DispatchedMessage[]>;

  // ---- Admin jobs (durable, idempotent) ----
  insertJob(job: NotificationJobRecord): Promise<{ created: boolean; existing?: NotificationJobRecord }>;
  getJob(id: string): Promise<NotificationJobRecord | undefined>;
  getJobByIdempotencyKey(key: string): Promise<NotificationJobRecord | undefined>;
  updateJob(job: NotificationJobRecord): Promise<void>;
  /** Due scheduled jobs for the runner; running jobs excluded (claim upstream). */
  dueJobs(nowIso: string): Promise<NotificationJobRecord[]>;
}

export class InMemoryNotificationStore implements NotificationStore {
  private readonly prefs = new Map<string, NotificationPreferences>();
  private readonly templates = new Map<string, MessageTemplate>();
  private readonly notifications = new Map<string, InAppNotification>();
  private readonly dedupeIndex = new Map<string, string>();
  private readonly dispatches = new Map<string, DispatchedMessage[]>();
  private readonly jobs = new Map<string, NotificationJobRecord>();

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
    this.notifications.set(notification.id, { ...notification });
    return { created: true };
  }

  /**
   * Ownership rule: a row is visible when it belongs to the caller's org
   * AND (it targets them explicitly OR has org-wide/broadcast audience).
   */
  private visibleTo(n: InAppNotification, orgId: string, userId: string | undefined): boolean {
    if (n.orgId !== orgId) return false;
    if (n.audienceType === "user") return !!userId && n.userId === userId;
    return true;
  }

  async getForUser(id: string, orgId: string, userId: string): Promise<InAppNotification | undefined> {
    const n = this.notifications.get(id);
    return n && this.visibleTo(n, orgId, userId) ? { ...n } : undefined;
  }

  async listForUser(orgId: string, userId?: string, filters?: UserInboxFilters): Promise<InAppNotification[]> {
    const rows = [...this.notifications.values()]
      .filter((n) => this.visibleTo(n, orgId, userId))
      .filter((n) => (filters?.unreadOnly ? !n.readAt : true))
      .filter((n) => (filters?.includeArchived ? true : !n.archivedAt))
      .filter((n) => (filters?.category ? n.category === filters.category : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 50;
    return rows.slice(offset, offset + limit).map((n) => ({ ...n }));
  }

  async unreadCount(orgId: string, userId: string): Promise<number> {
    let count = 0;
    for (const n of this.notifications.values()) {
      if (this.visibleTo(n, orgId, userId) && !n.readAt && !n.archivedAt) count += 1;
    }
    return count;
  }

  async markRead(id: string, orgId: string, userId: string, at: string): Promise<boolean> {
    const n = this.notifications.get(id);
    if (!n || !this.visibleTo(n, orgId, userId)) return false;
    n.readAt = at;
    n.updatedAt = at;
    return true;
  }

  async markUnread(id: string, orgId: string, userId: string, at: string): Promise<boolean> {
    const n = this.notifications.get(id);
    if (!n || !this.visibleTo(n, orgId, userId)) return false;
    n.readAt = undefined;
    n.updatedAt = at;
    return true;
  }

  async markAllRead(orgId: string, userId: string, at: string): Promise<number> {
    let changed = 0;
    for (const n of this.notifications.values()) {
      if (this.visibleTo(n, orgId, userId) && !n.readAt && !n.archivedAt) {
        n.readAt = at;
        n.updatedAt = at;
        changed += 1;
      }
    }
    return changed;
  }

  async archive(id: string, orgId: string, userId: string, at: string): Promise<boolean> {
    const n = this.notifications.get(id);
    if (!n || !this.visibleTo(n, orgId, userId)) return false;
    n.archivedAt = at;
    n.updatedAt = at;
    return true;
  }

  async purgeExpired(nowIso: string): Promise<number> {
    let purged = 0;
    for (const [id, n] of Array.from(this.notifications.entries())) {
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

  async insertJob(job: NotificationJobRecord): Promise<{ created: boolean; existing?: NotificationJobRecord }> {
    const existing = this.jobs.get(job.idempotencyKey);
    if (existing) return { created: false, existing: { ...existing } };
    this.jobs.set(job.idempotencyKey, { ...job });
    return { created: true };
  }

  async getJob(id: string): Promise<NotificationJobRecord | undefined> {
    const job = [...this.jobs.values()].find((j) => j.id === id);
    return job ? { ...job } : undefined;
  }

  async getJobByIdempotencyKey(key: string): Promise<NotificationJobRecord | undefined> {
    const job = this.jobs.get(key);
    return job ? { ...job } : undefined;
  }

  async updateJob(job: NotificationJobRecord): Promise<void> {
    this.jobs.set(job.idempotencyKey, { ...job, updatedAt: new Date().toISOString() });
  }

  async dueJobs(nowIso: string): Promise<NotificationJobRecord[]> {
    return [...this.jobs.values()]
      .filter(
        (j) =>
          (j.status === "scheduled" || j.status === "draft") &&
          (!j.scheduledAt || j.scheduledAt <= nowIso),
      )
      .map((j) => ({ ...j }));
  }
}

/** Outbound transport seam for every non-in-app route. */
export interface RouteTransport {
  readonly kind: "email" | "web_push" | "sms" | "whatsapp" | "webhook";
  send(message: DispatchedMessage): Promise<{ delivered: boolean; error?: string }>;
}

export type AudienceResolver = (
  audience: AdminAudience,
) => Promise<Array<{ orgId: string; userId: string }>>;
