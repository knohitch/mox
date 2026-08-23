import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type {
  DispatchedMessage,
  InAppNotification,
  MessageTemplate,
  NotificationStore,
  NotificationPreferences,
} from "@mox/notification-service";
import type { MoxDb } from "./client.js";
import { dispatchedMessages, inAppNotifications, messageTemplates, notificationPreferences } from "./schema/index.js";

/**
 * PostgreSQL notification store (Prompt 00 §C): in-app notification records
 * are business truth that must survive restarts; dedupe is enforced by the
 * unique (org, dedupe_key) index with ON CONFLICT DO NOTHING.
 */

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

  async markRead(id: string, at: string): Promise<void> {
    await this.db
      .update(inAppNotifications)
      .set({ readAt: new Date(at) })
      .where(eq(inAppNotifications.id, id));
  }

  async archive(id: string, at: string): Promise<void> {
    await this.db
      .update(inAppNotifications)
      .set({ archivedAt: new Date(at) })
      .where(eq(inAppNotifications.id, id));
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
    resourceType: n.resourceType ?? null,
    resourceId: n.resourceId ?? null,
    dedupeKey: n.dedupeKey ?? null,
    readAt: n.readAt ? new Date(n.readAt) : null,
    archivedAt: n.archivedAt ? new Date(n.archivedAt) : null,
    expiresAt: n.expiresAt ? new Date(n.expiresAt) : null,
    createdAt: new Date(n.createdAt),
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
    readAt: row.readAt?.toISOString(),
    archivedAt: row.archivedAt?.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
