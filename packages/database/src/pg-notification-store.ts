import type {
  AdminAudience,
  AudienceType,
  DispatchedMessage,
  InAppNotification,
  MessageTemplate,
  NotificationJobRecord,
  NotificationStore,
  NotificationPreferences,
  Severity,
} from "@mox/notification-service";
import type { UserInboxFilters } from "@mox/notification-service";
import type { MoxDb } from "./client.js";
import { dispatchedMessages, inAppNotifications, messageTemplates, notificationJobs, notificationPreferences } from "./schema/index.js";
import { and, asc, desc, eq, isNull, lte, sql, type SQL } from "drizzle-orm";

/**
 * PostgreSQL notification store (Prompt 00 §C): in-app notification records
 * are business truth that must survive restarts; dedupe is enforced by the
 * unique (org, dedupe_key) index with ON CONFLICT DO NOTHING.
 */

/**
 * Visibility rule as SQL (Prompt 02): a row is visible when it belongs to
 * the org AND either targets nobody exclusively (org/broadcast) or targets
 * exactly this user. An absent/empty userId sees only org-wide rows.
 */
function visibleSql(userId: string | undefined): SQL {
  const at = inAppNotifications.audienceType;
  const uid = inAppNotifications.userId;
  return userId
    ? sql`(${at} <> 'user' OR ${uid} = ${userId})`
    : sql`${at} <> 'user'`;
}

export class PgNotificationStore implements NotificationStore {
  constructor(private readonly db: MoxDb) {}


  async upsertPreferences(prefs: NotificationPreferences): Promise<void> {
    const values = {
      orgId: prefs.orgId,
      userId: prefs.userId ?? null,
      routes: prefs.routes as unknown as object,
      mutedEventTypes: prefs.mutedEventTypes as unknown as object,
      updatedAt: new Date(),
    };
    // Preferences key on (orgId, userId|null); resolve by lookup then update
    // or insert so restarts converge on one row per (org, user) pair.
    const existing = await this.getPreferencesRow(prefs.orgId, prefs.userId);
    if (existing) {
      await this.db
        .update(notificationPreferences)
        .set(values)
        .where(eq(notificationPreferences.id, existing.id));
    } else {
      await this.db.insert(notificationPreferences).values(values);
    }
  }

  async getPreferences(orgId: string, userId?: string): Promise<NotificationPreferences | undefined> {
    const row = await this.getPreferencesRow(orgId, userId);
    if (!row) return undefined;
    return {
      orgId: row.orgId,
      userId: row.userId ?? undefined,
      routes: (row.routes ?? {}) as NotificationPreferences["routes"],
      mutedEventTypes: (row.mutedEventTypes ?? []) as NotificationPreferences["mutedEventTypes"],
    };
  }

  private async getPreferencesRow(orgId: string, userId?: string) {
    const keyColumn = sql`coalesce(${notificationPreferences.userId}::text, '*')`;
    const rows = await this.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.orgId, orgId),
          eq(keyColumn, userId ?? "*"),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async putTemplate(template: MessageTemplate): Promise<void> {
    const values = {
      eventType: template.eventType,
      locale: template.locale,
      title: template.title,
      body: template.body,
      updatedAt: new Date(),
    };
    const existing = await this.db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.eventType, template.eventType), eq(messageTemplates.locale, template.locale)))
      .limit(1);
    if (existing[0]) {
      await this.db.update(messageTemplates).set(values).where(eq(messageTemplates.id, existing[0].id));
    } else {
      await this.db.insert(messageTemplates).values(values);
    }
  }

  async getTemplate(eventType: string, locale: string): Promise<MessageTemplate | undefined> {
    const rows = await this.db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.eventType, eventType), eq(messageTemplates.locale, locale)))
      .limit(1);
    return rows[0]
      ? { eventType: rows[0].eventType as MessageTemplate["eventType"], locale: rows[0].locale, title: rows[0].title, body: rows[0].body }
      : undefined;
  }

  /** Returns the existing notification when dedupeKey already seen. */
  async insert(notification: InAppNotification): Promise<{ created: boolean; existing?: InAppNotification }> {
    if (notification.dedupeKey) {
      const inserted = await this.db
        .insert(inAppNotifications)
        .values(toNotificationRow(notification))
        .onConflictDoNothing({
          target: [inAppNotifications.orgId, inAppNotifications.dedupeKey],
        })
        .returning({ id: inAppNotifications.id });
      if (inserted.length > 0) return { created: true };
      const existingRows = await this.db
        .select()
        .from(inAppNotifications)
        .where(
          and(
            eq(inAppNotifications.orgId, notification.orgId),
            eq(inAppNotifications.dedupeKey, notification.dedupeKey),
          ),
        )
        .limit(1);
      return existingRows[0]
        ? { created: false, existing: rowToNotification(existingRows[0]) }
        : { created: true };
    }
    await this.db.insert(inAppNotifications).values(toNotificationRow(notification));
    return { created: true };
  }

  async get(id: string): Promise<InAppNotification | undefined> {
    const rows = await this.db.select().from(inAppNotifications).where(eq(inAppNotifications.id, id)).limit(1);
    return rows[0] ? rowToNotification(rows[0]) : undefined;
  }

  async list(orgId: string, options?: { unreadOnly?: boolean; includeArchived?: boolean }): Promise<InAppNotification[]> {
    const filters = [eq(inAppNotifications.orgId, orgId)];
    if (options?.unreadOnly) filters.push(isNull(inAppNotifications.readAt));
    if (!options?.includeArchived) filters.push(isNull(inAppNotifications.archivedAt));
    const rows = await this.db
      .select()
      .from(inAppNotifications)
      .where(and(...filters))
      .orderBy(desc(inAppNotifications.createdAt));
    return rows.map(rowToNotification);
  }

  async purgeExpired(nowIso: string): Promise<number> {
    const purged = await this.db
      .delete(inAppNotifications)
      .where(lte(inAppNotifications.expiresAt, new Date(nowIso)))
      .returning({ id: inAppNotifications.id });
    return purged.length;
  }

  async recordDispatch(message: DispatchedMessage): Promise<void> {
    await this.db.insert(dispatchedMessages).values({
      id: message.id,
      orgId: message.orgId,
      userId: message.userId ?? null,
      eventType: message.eventType,
      route: message.route,
      recipient: message.recipient,
      title: message.title,
      body: message.body,
      at: new Date(message.at),
    });
  }

  async listDispatches(orgId: string): Promise<DispatchedMessage[]> {
    const rows = await this.db
      .select()
      .from(dispatchedMessages)
      .where(eq(dispatchedMessages.orgId, orgId))
      .orderBy(asc(dispatchedMessages.at));
    return rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      userId: row.userId ?? undefined,
      eventType: row.eventType as DispatchedMessage["eventType"],
      route: row.route as DispatchedMessage["route"],
      recipient: row.recipient,
      title: row.title,
      body: row.body,
      at: row.at.toISOString(),
    }));
  }

  // ---- Prompt 02: ownership-scoped inbox -------------------------------------

  async getForUser(id: string, orgId: string, userId: string): Promise<InAppNotification | undefined> {
    const rows = await this.db
      .select()
      .from(inAppNotifications)
      .where(
        and(
          eq(inAppNotifications.id, id),
          eq(inAppNotifications.orgId, orgId),
          visibleSql(userId),
        ),
      )
      .limit(1);
    return rows[0] ? rowToNotification(rows[0]) : undefined;
  }

  async listForUser(orgId: string, userId: string | undefined, filters?: UserInboxFilters): Promise<InAppNotification[]> {
    const conditions = [
      eq(inAppNotifications.orgId, orgId),
      visibleSql(userId),
    ];
    if (filters?.unreadOnly) conditions.push(isNull(inAppNotifications.readAt));
    if (!filters?.includeArchived) conditions.push(isNull(inAppNotifications.archivedAt));
    if (filters?.category) conditions.push(eq(inAppNotifications.category, filters.category));
    const rows = await this.db
      .select()
      .from(inAppNotifications)
      .where(and(...conditions))
      .orderBy(desc(inAppNotifications.createdAt))
      .limit(filters?.limit ?? 50)
      .offset(filters?.offset ?? 0);
    return rows.map(rowToNotification);
  }

  async unreadCount(orgId: string, userId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(inAppNotifications)
      .where(
        and(
          eq(inAppNotifications.orgId, orgId),
          visibleSql(userId),
          isNull(inAppNotifications.readAt),
          isNull(inAppNotifications.archivedAt),
        ),
      );
    return Number(result[0]?.count ?? 0);
  }

  async markRead(id: string, orgId: string, userId: string, at: string): Promise<boolean> {
    return this.markForUser(id, orgId, userId, { readAt: new Date(at), updatedAt: new Date(at) });
  }

  async markUnread(id: string, orgId: string, userId: string, at: string): Promise<boolean> {
    return this.markForUser(id, orgId, userId, { readAt: null, updatedAt: new Date(at) });
  }

  private async markForUser(
    id: string,
    orgId: string,
    userId: string,
    patch: { readAt: Date | null; updatedAt: Date },
  ): Promise<boolean> {
    const updated = await this.db
      .update(inAppNotifications)
      .set(patch)
      .where(
        and(
          eq(inAppNotifications.id, id),
          eq(inAppNotifications.orgId, orgId),
          visibleSql(userId),
        ),
      )
      .returning({ id: inAppNotifications.id });
    return updated.length > 0;
  }

  async markAllRead(orgId: string, userId: string, at: string): Promise<number> {
    const updated = await this.db
      .update(inAppNotifications)
      .set({ readAt: new Date(at), updatedAt: new Date(at) })
      .where(
        and(
          eq(inAppNotifications.orgId, orgId),
          visibleSql(userId),
          isNull(inAppNotifications.readAt),
          isNull(inAppNotifications.archivedAt),
        ),
      )
      .returning({ id: inAppNotifications.id });
    return updated.length;
  }

  async archive(id: string, orgId: string, userId: string, at: string): Promise<boolean> {
    const updated = await this.db
      .update(inAppNotifications)
      .set({ archivedAt: new Date(at), updatedAt: new Date(at) })
      .where(
        and(
          eq(inAppNotifications.id, id),
          eq(inAppNotifications.orgId, orgId),
          visibleSql(userId),
        ),
      )
      .returning({ id: inAppNotifications.id });
    return updated.length > 0;
  }

  // ---- Prompt 02: durable admin jobs -----------------------------------------

  async insertJob(job: NotificationJobRecord): Promise<{ created: boolean; existing?: NotificationJobRecord }> {
    const inserted = await this.db
      .insert(notificationJobs)
      .values(toJobRow(job))
      .onConflictDoNothing({ target: notificationJobs.idempotencyKey })
      .returning({ id: notificationJobs.id });
    if (inserted.length === 0) {
      const existing = await this.getJobByIdempotencyKey(job.idempotencyKey);
      return existing ? { created: false, existing } : { created: true };
    }
    const created = await this.getJobByIdempotencyKey(job.idempotencyKey);
    return created ? { created: true, existing: created } : { created: true };
  }

  async getJob(id: string): Promise<NotificationJobRecord | undefined> {
    const rows = await this.db.select().from(notificationJobs).where(eq(notificationJobs.id, id)).limit(1);
    return rows[0] ? rowToJob(rows[0]) : undefined;
  }

  async getJobByIdempotencyKey(key: string): Promise<NotificationJobRecord | undefined> {
    const rows = await this.db
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.idempotencyKey, key))
      .limit(1);
    return rows[0] ? rowToJob(rows[0]) : undefined;
  }

  async updateJob(job: NotificationJobRecord): Promise<void> {
    await this.db
      .update(notificationJobs)
      .set({ ...toJobRow(job), updatedAt: new Date() })
      .where(eq(notificationJobs.idempotencyKey, job.idempotencyKey));
  }

  async dueJobs(nowIso: string): Promise<NotificationJobRecord[]> {
    const rows = await this.db
      .select()
      .from(notificationJobs)
      .where(
        and(
          sql`status in ('draft','scheduled')`,
          sql`(${notificationJobs.scheduledAt} IS NULL OR ${notificationJobs.scheduledAt} <= ${new Date(nowIso)})`,
        ),
      )
      .orderBy(asc(notificationJobs.scheduledAt))
      .limit(50);
    return rows.map(rowToJob);
  }
}

function toNotificationRow(n: InAppNotification) {
  return {
    id: n.id,
    orgId: n.orgId,
    userId: n.userId ?? null,
    eventType: n.eventType,
    severity: n.severity,
    title: n.title,
    body: n.body,
    audienceType: n.audienceType ?? "user",
    category: n.category ?? "system",
    createdBy: n.createdBy ?? null,
    scheduledAt: n.scheduledAt ? new Date(n.scheduledAt) : null,
    deliveryState: n.deliveryState ?? "ready",
    resourceType: n.resourceType ?? null,
    resourceId: n.resourceId ?? null,
    dedupeKey: n.dedupeKey ?? null,
    readAt: n.readAt ? new Date(n.readAt) : null,
    archivedAt: n.archivedAt ? new Date(n.archivedAt) : null,
    expiresAt: n.expiresAt ? new Date(n.expiresAt) : null,
    createdAt: new Date(n.createdAt),
    updatedAt: new Date(n.updatedAt ?? n.createdAt),
  };
}

function rowToNotification(row: typeof inAppNotifications.$inferSelect): InAppNotification {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId ?? undefined,
    eventType: row.eventType as InAppNotification["eventType"],
    severity: row.severity as InAppNotification["severity"],
    title: row.title,
    body: row.body,
    resourceType: row.resourceType ?? undefined,
    resourceId: row.resourceId ?? undefined,
    dedupeKey: row.dedupeKey ?? undefined,
    audienceType: (row.audienceType ?? "user") as InAppNotification["audienceType"],
    category: (row.category ?? "system") as InAppNotification["category"],
    createdBy: row.createdBy ?? undefined,
    scheduledAt: row.scheduledAt?.toISOString(),
    deliveryState: (row.deliveryState ?? "ready") as InAppNotification["deliveryState"],
    updatedAt: row.updatedAt?.toISOString?.() ?? row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString(),
    archivedAt: row.archivedAt?.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}


function toJobRow(job: NotificationJobRecord) {
  return {
    orgId: job.orgId ?? null,
    audienceType: job.audienceType,
    audiencePayload: job.audiencePayload as unknown as object,
    title: job.title,
    body: job.body,
    severity: job.severity,
    category: job.category,
    resourceType: job.resourceType ?? null,
    resourceId: job.resourceId ?? null,
    status: job.status,
    scheduledAt: job.scheduledAt ? new Date(job.scheduledAt) : null,
    startedAt: job.startedAt ? new Date(job.startedAt) : null,
    completedAt: job.completedAt ? new Date(job.completedAt) : null,
    fanoutTotal: job.fanoutTotal,
    fanoutDone: job.fanoutDone,
    error: job.error ?? null,
    createdBy: job.createdBy,
    idempotencyKey: job.idempotencyKey,
  };
}

function rowToJob(row: typeof notificationJobs.$inferSelect): NotificationJobRecord {
  return {
    id: row.id,
    orgId: row.orgId ?? undefined,
    audienceType: row.audienceType as AudienceType,
    audiencePayload: (row.audiencePayload ?? {}) as Record<string, unknown>,
    title: row.title,
    body: row.body,
    severity: row.severity as Severity,
    category: row.category as NotificationJobRecord["category"],
    resourceType: row.resourceType ?? undefined,
    resourceId: row.resourceId ?? undefined,
    status: row.status as NotificationJobRecord["status"],
    scheduledAt: row.scheduledAt?.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    fanoutTotal: row.fanoutTotal,
    fanoutDone: row.fanoutDone,
    error: row.error ?? undefined,
    createdBy: row.createdBy,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
