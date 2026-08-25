import type {
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
    ? sql`((${at} = 'org' AND ${uid} IS NULL) OR ${uid} = ${userId})`
    : sql`(${at} = 'org' AND ${uid} IS NULL)`;
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
    const values = toDispatchRow(message);
    const insert = this.db.insert(dispatchedMessages).values(values);
    if (message.dedupeKey) {
      await insert.onConflictDoNothing({ target: [dispatchedMessages.orgId, dispatchedMessages.dedupeKey] });
      return;
    }
    await insert;
  }

  // ---- Security Repair 05B §K: dispatch outbox -----------------------------------

  /** Durable 'sending' record BEFORE the transport call (dedupe-guarded). */
  async recordDispatchPrepared(message: DispatchedMessage): Promise<void> {
    const values = {
      ...toDispatchRow({ ...message, deliveryState: "sending", attempts: (message.attempts ?? 0) + 1 }),
      updatedAt: new Date(),
    };
    await this.db
      .insert(dispatchedMessages)
      .values(values)
      .onConflictDoNothing({ target: [dispatchedMessages.orgId, dispatchedMessages.dedupeKey] });
  }

  async markDispatchSent(message: DispatchedMessage): Promise<void> {
    await this.updateDispatchState(message, "sent", undefined);
  }

  async markDispatchFailed(message: DispatchedMessage, error: string): Promise<void> {
    await this.updateDispatchState(message, "failed", error);
  }

  async markDispatchPending(message: DispatchedMessage): Promise<void> {
    await this.updateDispatchState(message, "pending", message.lastError);
  }

  async markDispatchUncertain(message: DispatchedMessage): Promise<void> {
    await this.updateDispatchState(message, "uncertain", "transport outcome unknown (crash before durable terminal record)");
  }

  private async updateDispatchState(message: DispatchedMessage, state: string, lastError: string | undefined): Promise<void> {
    const conditions = [eq(dispatchedMessages.id, message.id)];
    await this.db
      .update(dispatchedMessages)
      .set({ deliveryState: state, lastError: lastError ?? null, updatedAt: new Date() })
      .where(and(...conditions));
  }

  async sweepDispatchOutbox(nowIso: string, uncertainAfterMs: number): Promise<{ uncertain: number }> {
    const cutoff = new Date(Date.parse(nowIso) - uncertainAfterMs);
    const swept = await this.db
      .update(dispatchedMessages)
      .set({
        deliveryState: "uncertain",
        lastError: "transport outcome unknown (crash before durable terminal record)",
        updatedAt: new Date(),
      })
      .where(and(eq(dispatchedMessages.deliveryState, "sending"), lte(dispatchedMessages.updatedAt, cutoff)))
      .returning({ id: dispatchedMessages.id });
    return { uncertain: swept.length };
  }

  async listRetriableDispatches(nowIso: string, limit: number): Promise<DispatchedMessage[]> {
    void nowIso;
    const rows = await this.db
      .select()
      .from(dispatchedMessages)
      .where(eq(dispatchedMessages.deliveryState, "pending"))
      .orderBy(asc(dispatchedMessages.updatedAt))
      .limit(limit);
    return rows.map(rowToDispatch);
  }

  async listDispatches(orgId: string): Promise<DispatchedMessage[]> {
    const rows = await this.db
      .select()
      .from(dispatchedMessages)
      .where(eq(dispatchedMessages.orgId, orgId))
      .orderBy(asc(dispatchedMessages.at));
    return rows.map(rowToDispatch);
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
      .onConflictDoNothing({ target: [notificationJobs.createdBy, notificationJobs.idempotencyKey] })
      .returning({ id: notificationJobs.id });
    if (inserted.length === 0) {
      const existing = await this.getJobByIdempotencyKey(job.createdBy, job.idempotencyKey);
      return existing ? { created: false, existing } : { created: true };
    }
    const created = await this.getJobByIdempotencyKey(job.createdBy, job.idempotencyKey);
    return created ? { created: true, existing: created } : { created: true };
  }

  async getJob(id: string): Promise<NotificationJobRecord | undefined> {
    const rows = await this.db.select().from(notificationJobs).where(eq(notificationJobs.id, id)).limit(1);
    return rows[0] ? rowToJob(rows[0]) : undefined;
  }

  async getJobByIdempotencyKey(createdBy: string, key: string): Promise<NotificationJobRecord | undefined> {
    const rows = await this.db
      .select()
      .from(notificationJobs)
      .where(and(eq(notificationJobs.createdBy, createdBy), eq(notificationJobs.idempotencyKey, key)))
      .limit(1);
    return rows[0] ? rowToJob(rows[0]) : undefined;
  }

  async updateJob(job: NotificationJobRecord): Promise<void> {
    await this.db
      .update(notificationJobs)
      .set({ ...toJobRow(job), updatedAt: new Date() })
      .where(and(eq(notificationJobs.createdBy, job.createdBy), eq(notificationJobs.idempotencyKey, job.idempotencyKey)));
  }

  /** Security Repair 05B §A: compare-and-set fencing on job writebacks. The
   *  claim identity is matched from the ARGUMENT; the SET releases it. */
  async updateJobFenced(job: NotificationJobRecord, expectedClaimVersion: number): Promise<boolean> {
    const ownerMatch = job.claimOwner
      ? eq(notificationJobs.claimOwner, job.claimOwner)
      : isNull(notificationJobs.claimOwner);
    const updated = await this.db
      .update(notificationJobs)
      .set({ ...toJobRow({ ...job, claimOwner: undefined, claimExpiresAt: undefined }), updatedAt: new Date() })
      .where(
        and(
          eq(notificationJobs.id, job.id),
          ownerMatch,
          eq(notificationJobs.claimVersion, BigInt(expectedClaimVersion)),
        ),
      )
      .returning({ id: notificationJobs.id });
    return updated.length > 0;
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

  async claimDueJobs(nowIso: string, workerId: string, leaseMs: number, limit: number): Promise<NotificationJobRecord[]> {
    const now = new Date(nowIso);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const result = await this.db.execute(sql`
      WITH claimable AS (
        SELECT id
        FROM notification_jobs
        WHERE (
          status IN ('draft', 'scheduled')
          AND (scheduled_at IS NULL OR scheduled_at <= ${now})
        )
        OR (
          status = 'running'
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at <= ${now}
        )
        ORDER BY scheduled_at ASC NULLS FIRST, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE notification_jobs AS job
      SET status = 'running',
          started_at = coalesce(job.started_at, ${now}),
          claim_owner = ${workerId},
          claim_expires_at = ${leaseUntil},
          claim_version = coalesce(job.claim_version, 0) + 1,
          attempts = job.attempts + 1,
          updated_at = ${now}
      FROM claimable
      WHERE job.id = claimable.id
      RETURNING job.*
    `);
    const rows = Array.isArray((result as { rows?: unknown[] }).rows)
      ? (result as { rows: Record<string, unknown>[] }).rows
      : [];
    return rows.map(rowToJobFromSqlRow);
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
    attempts: job.attempts,
    claimOwner: job.claimOwner ?? null,
    claimExpiresAt: job.claimExpiresAt ? new Date(job.claimExpiresAt) : null,
    claimVersion: BigInt(job.claimVersion ?? 0),
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
    attempts: row.attempts,
    claimOwner: row.claimOwner ?? undefined,
    claimExpiresAt: row.claimExpiresAt?.toISOString(),
    claimVersion: Number(row.claimVersion ?? 0),
    error: row.error ?? undefined,
    createdBy: row.createdBy,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToJobFromSqlRow(row: Record<string, unknown>): NotificationJobRecord {
  const dateIso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  const maybeDateIso = (value: unknown): string | undefined =>
    value === null || value === undefined ? undefined : dateIso(value);
  return {
    id: String(row.id),
    orgId: row.org_id ? String(row.org_id) : undefined,
    audienceType: String(row.audience_type) as AudienceType,
    audiencePayload: (row.audience_payload ?? {}) as Record<string, unknown>,
    title: String(row.title),
    body: String(row.body),
    severity: String(row.severity) as Severity,
    category: String(row.category) as NotificationJobRecord["category"],
    resourceType: row.resource_type ? String(row.resource_type) : undefined,
    resourceId: row.resource_id ? String(row.resource_id) : undefined,
    status: String(row.status) as NotificationJobRecord["status"],
    scheduledAt: maybeDateIso(row.scheduled_at),
    startedAt: maybeDateIso(row.started_at),
    completedAt: maybeDateIso(row.completed_at),
    fanoutTotal: Number(row.fanout_total ?? 0),
    fanoutDone: Number(row.fanout_done ?? 0),
    attempts: Number(row.attempts ?? 0),
    claimOwner: row.claim_owner ? String(row.claim_owner) : undefined,
    claimExpiresAt: maybeDateIso(row.claim_expires_at),
    claimVersion: Number(row.claim_version ?? 0),
    error: row.error ? String(row.error) : undefined,
    createdBy: String(row.created_by),
    idempotencyKey: String(row.idempotency_key),
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
  };
}

function toDispatchRow(message: DispatchedMessage) {
  return {
    id: message.id,
    orgId: message.orgId,
    userId: message.userId ?? null,
    eventType: message.eventType,
    route: message.route,
    recipient: message.recipient,
    title: message.title,
    body: message.body,
    dedupeKey: message.dedupeKey ?? null,
    at: new Date(message.at),
    deliveryState: message.deliveryState ?? "sent",
    attempts: message.attempts ?? 1,
    lastError: message.lastError ?? null,
  };
}

function rowToDispatch(row: typeof dispatchedMessages.$inferSelect): DispatchedMessage {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId ?? undefined,
    eventType: row.eventType as DispatchedMessage["eventType"],
    route: row.route as DispatchedMessage["route"],
    recipient: row.recipient,
    title: row.title,
    body: row.body,
    dedupeKey: row.dedupeKey ?? undefined,
    at: row.at.toISOString(),
    deliveryState: (row.deliveryState ?? "sent") as DispatchedMessage["deliveryState"],
    attempts: row.attempts ?? 1,
    lastError: row.lastError ?? undefined,
  };
}
