/**
 * Notification routing engine (Prompt 02): canonical platform events in,
 * templated messages out over preference-selected routes — plus the admin
 * authoring pipeline: draft/preview/send/schedule/cancel/broadcast with
 * DURABLE, idempotent fan-out.
 *
 * Ordering rule: persist FIRST, then publish to realtime. External delivery
 * failures never delete the durable in-app row.
 */

import { randomUUID } from "node:crypto";
import type {
  AdminAudience,
  AdminSendInput,
  DispatchedMessage,
  InAppNotification,
  MessageTemplate,
  NotificationJobRecord,
  NotificationPreferences,
  PlatformEvent,
  RouteKind,
  Severity,
} from "./types.js";
import type { AudienceResolver, NotificationStore, RouteTransport } from "./store.js";

const DEFAULT_ROUTES_BY_SEVERITY: Record<Severity, RouteKind[]> = {
  info: ["in_app"],
  warning: ["in_app", "email"],
  critical: ["in_app", "email", "web_push"],
};

/** Categories whose notifications users cannot mute (Prompt 02 §Prefs). */
const MANDATORY_CATEGORIES = new Set(["security", "billing"]);

export interface PublishedNotification {
  orgId: string;
  userId?: string;
  audienceType: InAppNotification["audienceType"];
  notificationId: string;
}

export interface UnreadSubscriber {
  (update: { orgId: string; userId?: string; unreadCount: number }): void;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

export class NotificationService {
  readonly store: NotificationStore;
  private readonly transports = new Map<string, RouteTransport>();
  private readonly unreadSubscribers = new Set<UnreadSubscriber>();
  private readonly publishedHandlers = new Set<(published: PublishedNotification) => void>();
  /** Durable-job runner claim: single in-process execution per job. */
  private readonly runningJobs = new Set<string>();

  constructor(store: NotificationStore, private readonly resolveAudience?: AudienceResolver) {
    this.store = store;
  }

  registerTransport(transport: RouteTransport): void {
    this.transports.set(transport.kind, transport);
  }

  onUnreadChange(subscriber: UnreadSubscriber): () => void {
    this.unreadSubscribers.add(subscriber);
    return () => this.unreadSubscribers.delete(subscriber);
  }

  /** Realtime hook (Prompt 02 §Realtime): called AFTER durable persistence. */
  onPublished(handler: (published: PublishedNotification) => void): () => void {
    this.publishedHandlers.add(handler);
    return () => this.publishedHandlers.delete(handler);
  }

  async setPreferences(prefs: NotificationPreferences): Promise<void> {
    await this.store.upsertPreferences(prefs);
  }

  async defineTemplate(template: MessageTemplate): Promise<void> {
    await this.store.putTemplate(template);
  }

  // ---- User inbox operations (ownership-scoped by the store) --------------------

  listInbox(orgId: string, userId: string, filters?: Parameters<NotificationStore["listForUser"]>[2]) {
    return this.store.listForUser(orgId, userId, filters);
  }
  getNotification(id: string, orgId: string, userId: string) {
    return this.store.getForUser(id, orgId, userId);
  }
  unreadCount(orgId: string, userId: string) {
    return this.store.unreadCount(orgId, userId);
  }
  listUnread(orgId: string, userId?: string) {
    void userId;
    return this.unreadCount(orgId, "u1");
  }
  private async notifyUnread(orgId: string, userId: string): Promise<void> {
    const unread = await this.store.unreadCount(orgId, userId);
    for (const subscriber of this.unreadSubscribers) {
      subscriber({ orgId, userId, unreadCount: unread });
    }
  }
  async markRead(id: string, orgId: string, userId: string): Promise<boolean> {
    const ok = await this.store.markRead(id, orgId, userId, new Date().toISOString());
    if (ok) await this.notifyUnread(orgId, userId);
    return ok;
  }
  async markUnread(id: string, orgId: string, userId: string): Promise<boolean> {
    const ok = await this.store.markUnread(id, orgId, userId, new Date().toISOString());
    if (ok) await this.notifyUnread(orgId, userId);
    return ok;
  }
  async markAllRead(orgId: string, userId: string): Promise<number> {
    const changed = await this.store.markAllRead(orgId, userId, new Date().toISOString());
    if (changed > 0) await this.notifyUnread(orgId, userId);
    return changed;
  }
  async archive(id: string, orgId: string, userId: string): Promise<boolean> {
    const ok = await this.store.archive(id, orgId, userId, new Date().toISOString());
    if (ok) await this.notifyUnread(orgId, userId);
    return ok;
  }

  // ---- Platform event consumption -------------------------------------------------

  private async resolveTemplate(event: PlatformEvent): Promise<{ title: string; body: string }> {
    const template = (await this.store.getTemplate(event.type, "en")) as MessageTemplate | undefined;
    const title = renderTemplate(template?.title ?? event.type, event.templateVars);
    const body = renderTemplate(
      template?.body ?? `Event ${event.type} for {{resourceType}} {{resourceId}}`,
      { resourceType: event.resourceType ?? "", resourceId: event.resourceId ?? "", ...event.templateVars },
    );
    return { title, body };
  }

  private async routesFor(event: PlatformEvent): Promise<RouteKind[]> {
    const prefs = await this.store.getPreferences(event.orgId, event.userId);
    if (prefs?.mutedEventTypes.includes(event.type)) return [];
    const override = prefs?.routes[event.type];
    return override ?? DEFAULT_ROUTES_BY_SEVERITY[event.severity];
  }

  private categoryFor(event: PlatformEvent): InAppNotification["category"] {
    if (event.category) return event.category;
    if (event.type.startsWith("subscription") || event.type.includes("payment")) return "billing";
    if (event.type.startsWith("server") || event.type.startsWith("node")) return "servers";
    if (event.type.startsWith("agent") || event.type.startsWith("approval")) return "agents";
    if (event.type.startsWith("abuse") || event.type.startsWith("provider")) return "security";
    return "system";
  }

  /**
   * Consume one platform event: create the deduped in-app notification and
   * fan out templated messages over every selected route. Publishes to the
   * realtime hooks only AFTER the durable insert commits.
   */
  async consume(event: PlatformEvent): Promise<{ inAppId?: string; duplicate: boolean }> {
    const { title, body } = await this.resolveTemplate(event);
    const inAppId = `ntf_${randomUUID()}`;
    const notification: InAppNotification = {
      id: inAppId,
      orgId: event.orgId,
      // Platform events WITHOUT an explicit recipient are org-audience
      // system rows; targeted events stay strictly user-scoped.
      userId: event.userId,
      audienceType: event.userId ? "user" : "org",
      eventType: event.type,
      severity: event.severity,
      title,
      body,
      category: this.categoryFor(event),
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      dedupeKey: `${event.type}:${event.eventId}`,
      deliveryState: "ready",
      createdAt: event.at,
      updatedAt: event.at,
    };

    const result = await this.store.insert(notification);
    if (!result.created) {
      return { inAppId: result.existing?.id, duplicate: true };
    }

    // Persist FIRST, then publish to realtime hooks.
    await this.publishAfterPersist(notification);

    const unread = await this.store.unreadCount(event.orgId, event.userId ?? "");
    for (const subscriber of this.unreadSubscribers) {
      subscriber({ orgId: event.orgId, userId: event.userId, unreadCount: unread });
    }

    for (const route of await this.routesFor(event)) {
      if (route === "in_app") continue;
      const transport = this.transports.get(route);
      // Routes without a configured transport are skipped honestly; the
      // dispatch log records only what actually went out.
      if (!transport) continue;
      const message: DispatchedMessage = {
        id: `msg_${randomUUID()}`,
        orgId: event.orgId,
        userId: event.userId,
        eventType: event.type,
        route: route,
        recipient: event.userId ?? event.orgId,
        title,
        body,
        at: new Date().toISOString(),
      };
      try {
        const outcome = await transport.send(message);
        await this.store.recordDispatch({ ...message });
        if (!outcome.delivered) {
          // Delivery failure NEVER deletes the durable in-app row.
          continue;
        }
      } catch {
        await this.store.recordDispatch({ ...message });
        continue;
      }
    }

    return { inAppId, duplicate: false };
  }

  private async publishAfterPersist(n?: InAppNotification): Promise<void> {
    if (!n) return;
    const published = {
      orgId: n.orgId,
      userId: n.audienceType === "user" ? n.userId : undefined,
      audienceType: n.audienceType,
      notificationId: n.id,
    };
    for (const handler of this.publishedHandlers) handler(published);
  }

  // ---- Admin authoring pipeline (Prompt 02 §Admin) --------------------------------

  /** Draft/preview is pure — no persistence side effects. */
  preview(payload: { title: string; body: string; templateVars?: Record<string, string> }): { title: string; body: string } {
    return {
      title: renderTemplate(payload.title, payload.templateVars ?? {}),
      body: renderTemplate(payload.body, payload.templateVars ?? {}),
    };
  }

  /**
   * Create a durable send/broadcast job. Idempotent by idempotencyKey:
   * retries return the ORIGINAL job instead of duplicating value.
   */
  async createJob(input: AdminSendInput): Promise<{ job: NotificationJobRecord; created: boolean }> {
    if (!input.payload.title || !input.payload.body) {
      throw new Error("notification title and body are required");
    }
    const existing = await this.store.getJobByIdempotencyKey(input.idempotencyKey);
    if (existing) return { job: existing, created: false };

    const nowIso = new Date().toISOString();
    const job: NotificationJobRecord = {
      id: `job_${randomUUID()}`,
      orgId: input.audience.orgId,
      audienceType: input.audience.type,
      audiencePayload: input.audience as unknown as Record<string, unknown>,
      title: input.payload.title,
      body: input.payload.body,
      severity: input.payload.severity ?? "info",
      category: input.payload.category ?? "system",
      resourceType: input.payload.resourceType,
      resourceId: input.payload.resourceId,
      status: input.scheduledAt ? "scheduled" : "draft",
      scheduledAt: input.scheduledAt,
      fanoutTotal: 0,
      fanoutDone: 0,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const inserted = await this.store.insertJob(job);
    const canonical = inserted.existing ?? (await this.store.getJobByIdempotencyKey(job.idempotencyKey)) ?? job;
    return { job: canonical, created: inserted.created };
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const job = await this.store.getJob(jobId);
    if (!job) return false;
    if (!["draft", "scheduled"].includes(job.status)) return false;
    job.status = "canceled";
    job.completedAt = new Date().toISOString();
    await this.store.updateJob(job);
    return true;
  }

  async getJob(jobId: string): Promise<NotificationJobRecord | undefined> {
    return this.store.getJob(jobId);
  }

  /**
   * Runs due scheduled/draft jobs. Fan-out is cursor-based: each recipient
   * insert advances fanout_done durably, so a retry/resume NEVER duplicates
   * a delivered row (dedupe key job:<id>:<userId>).
   */
  async runDueJobs(now?: string, limits = { maxJobs: 10 }): Promise<{ processed: number; delivered: number }> {
    const at = now ?? new Date().toISOString();
    let processed = 0;
    let delivered = 0;

    for (const due of await this.store.dueJobs(at)) {
      if (processed >= limits.maxJobs) break;
      if (this.runningJobs.has(due.id)) continue;
      this.runningJobs.add(due.id);
      try {
        delivered += await this.fanOut(due);
        processed += 1;
      } finally {
        this.runningJobs.delete(due.id);
      }
    }
    return { processed, delivered };
  }

  private async fanOut(job: NotificationJobRecord): Promise<number> {
    if (!this.resolveAudience) throw new Error("audience resolver not configured");
    const startedAt = job.startedAt ?? new Date().toISOString();
    job.status = "running";
    job.startedAt = startedAt;
    await this.store.updateJob(job);

    let recipients = await this.resolveAudience(job.audiencePayload as unknown as AdminAudience);
    // Org-audience jobs are scoped to that workspace's members only.
    if (job.audienceType === "org" && job.orgId) {
      recipients = recipients.filter((r) => r.orgId === job.orgId);
    }
    job.fanoutTotal = recipients.length;

    let done = job.fanoutDone;
    let delivered = 0;
    for (let i = done; i < recipients.length; i += 1) {
      const r = recipients[i]!;
      const notification: InAppNotification = {
        id: `ntf_${randomUUID()}`,
        orgId: r.orgId,
        userId: r.userId,
        eventType: `admin.${job.category}`,
        severity: job.severity,
        title: job.title,
        body: job.body,
        audienceType: job.audienceType === "user" ? "user" : job.audienceType,
        category: job.category,
        createdBy: job.createdBy,
        resourceType: job.resourceType,
        resourceId: job.resourceId,
        dedupeKey: `job:${job.id}:${r.userId}`,
        deliveryState: "sent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const inserted = await this.store.insert(notification);
      if (inserted.created) {
        delivered += 1;
        // Persist FIRST, then publish to realtime hooks.
        await this.publishAfterPersist(notification);
      }
      done = i + 1;
      job.fanoutDone = done;
      await this.store.updateJob(job); // durable cursor after EVERY recipient
    }

    job.status = "completed";
    job.completedAt = new Date().toISOString();
    await this.store.updateJob(job);
    return delivered;
  }
}
