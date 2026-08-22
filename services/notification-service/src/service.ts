/**
 * Notification routing engine: canonical platform events in, templated
 * messages out over preference-selected routes. In-app notifications get
 * realtime unread updates via a subscriber callback.
 */

import type {
  DispatchedMessage,
  MessageTemplate,
  NotificationPreferences,
  PlatformEvent,
  RouteKind,
  Severity,
} from "./types.js";
import type { NotificationStore, RouteTransport } from "./store.js";

const DEFAULT_ROUTES_BY_SEVERITY: Record<Severity, RouteKind[]> = {
  info: ["in_app"],
  warning: ["in_app", "email"],
  critical: ["in_app", "email", "web_push"],
};

export interface UnreadSubscriber {
  (update: { orgId: string; userId?: string; unreadCount: number }): void;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

export class NotificationService {
  readonly store: NotificationStore;
  private readonly transports = new Map<string, RouteTransport>();
  private readonly subscribers = new Set<UnreadSubscriber>();

  constructor(store: import("./store.js").NotificationStore) {
    this.store = store;
  }

  registerTransport(transport: RouteTransport): void {
    this.transports.set(transport.kind, transport);
  }

  onUnreadChange(subscriber: UnreadSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async setPreferences(prefs: NotificationPreferences): Promise<void> {
    await this.store.upsertPreferences(prefs);
  }

  async defineTemplate(template: MessageTemplate): Promise<void> {
    await this.store.putTemplate(template);
  }

  private async routesFor(event: PlatformEvent): Promise<RouteKind[]> {
    const prefs = await this.store.getPreferences(event.orgId, event.userId);
    if (prefs?.mutedEventTypes.includes(event.type)) return [];
    const override = prefs?.routes[event.type];
    return override ?? DEFAULT_ROUTES_BY_SEVERITY[event.severity];
  }

  private async resolveTemplate(event: PlatformEvent): Promise<{ title: string; body: string }> {
    const template = (await this.store.getTemplate(event.type, "en")) as MessageTemplate | undefined;
    const title = renderTemplate(template?.title ?? event.type, event.templateVars);
    const body = renderTemplate(
      template?.body ?? `Event ${event.type} for {{resourceType}} {{resourceId}}`,
      { resourceType: event.resourceType ?? "", resourceId: event.resourceId ?? "", ...event.templateVars },
    );
    return { title, body };
  }

  /**
   * Consume one platform event: create the deduped in-app notification and
   * fan out templated messages over every selected route.
   */
  async consume(event: PlatformEvent): Promise<{ inAppId?: string; duplicate: boolean }> {
    const { title, body } = await this.resolveTemplate(event);
    const inAppId = `ntf_${crypto.randomUUID()}`;

    const result = await this.store.insert({
      id: inAppId,
      orgId: event.orgId,
      userId: event.userId,
      eventType: event.type,
      severity: event.severity,
      title,
      body,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      dedupeKey: `${event.type}:${event.eventId}`,
      createdAt: event.at,
    });

    if (!result.created) {
      return { inAppId: result.existing?.id, duplicate: true };
    }

    const unread = (await this.store.list(event.orgId, { unreadOnly: true })).length;
    for (const subscriber of this.subscribers) {
      subscriber({ orgId: event.orgId, userId: event.userId, unreadCount: unread });
    }

    for (const route of await this.routesFor(event)) {
      if (route === "in_app") continue;
      const transport = this.transports.get(route);
      // Routes without a configured transport are skipped honestly; the
      // dispatch log records only what actually went out.
      if (!transport) continue;
      const message: DispatchedMessage = {
        id: `msg_${crypto.randomUUID()}`,
        orgId: event.orgId,
        userId: event.userId,
        eventType: event.type,
        route: route,
        recipient: event.userId ?? event.orgId,
        title,
        body,
        at: new Date().toISOString(),
      };
      await transport.send(message);
      await this.store.recordDispatch(message);
    }
    return { inAppId, duplicate: false };
  }

  async markRead(orgId: string, notificationId: string): Promise<void> {
    await this.store.markRead(notificationId, new Date().toISOString());
    const unread = (await this.store.list(orgId, { unreadOnly: true })).length;
    for (const subscriber of this.subscribers) subscriber({ orgId, unreadCount: unread });
  }

  listUnread(orgId: string): Promise<number> {
    return this.store.list(orgId, { unreadOnly: true }).then((rows) => rows.length);
  }
}
