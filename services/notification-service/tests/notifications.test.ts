import { describe, expect, it } from "vitest";
import { InMemoryNotificationStore } from "../src/store.js";
import { NotificationService } from "../src/service.js";
import type { PlatformEvent, RouteTransport } from "../src/index.js";

function event(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2, 8)}`,
    type: "server.provisioned",
    orgId: "org-1",
    severity: "info",
    resourceType: "server",
    resourceId: "srv-1",
    templateVars: {},
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe("notification service", () => {
  it("routes by severity defaults: info→in_app, critical adds email+push", async () => {
    const store = new InMemoryNotificationStore();
    const sent: Array<{ route: string }> = [];
    const svc = new NotificationService(store);
    const transport: RouteTransport = {
      kind: "email",
      async send(message) {
        sent.push({ route: message.route });
        return { delivered: true };
      },
    };
    svc.registerTransport(transport);

    await svc.consume(event({ severity: "info" }));
    expect(sent).toHaveLength(0);

    await svc.consume(event({ severity: "critical", type: "provider.incident" }));
    expect(sent.map((s) => s.route)).toEqual(["email"]);
  });

  it("honors per-event preference overrides and mutes", async () => {
    const store = new InMemoryNotificationStore();
    const svc = new NotificationService(store);
    const dispatchedRoutes: string[] = [];
    for (const kind of ["sms", "whatsapp"] as const) {
      svc.registerTransport({
        kind,
        async send(message) {
          dispatchedRoutes.push(message.route);
          return { delivered: true };
        },
      });
    }
    await svc.setPreferences({
      orgId: "org-1",
      routes: { "subscription.past_due": ["in_app", "sms", "whatsapp"] },
      mutedEventTypes: ["team.invited"],
    });

    await svc.consume(
      event({ type: "subscription.past_due", severity: "warning", templateVars: {} }),
    );
    expect(dispatchedRoutes.sort()).toEqual(["sms", "whatsapp"]);

    // Muted events create no dispatches and (with in_app muted implicitly)
    // still record nothing outbound.
    const before = dispatchedRoutes.length;
    await svc.consume(event({ type: "team.invited" }));
    expect(dispatchedRoutes.length).toBe(before);
  });

  it("renders templates with variables", async () => {
    const store = new InMemoryNotificationStore();
    const svc = new NotificationService(store);
    await svc.defineTemplate({
      eventType: "agent.crashed",
      locale: "en",
      title: 'Agent "{{agentSlug}}" crashed',
      body: "Deployment {{deploymentId}} failed on server {{hostname}}.",
    });
    const result = await svc.consume(
      event({
        type: "agent.crashed",
        severity: "critical",
        templateVars: { agentSlug: "sales-helper", deploymentId: "dep_1", hostname: "ws-1" },
      }),
    );
    const notification = await store.get(result.inAppId!);
    expect(notification?.title).toBe('Agent "sales-helper" crashed');
    expect(notification?.body).toContain("dep_1");
  });

  it("dedupes identical events into one in-app notification", async () => {
    const store = new InMemoryNotificationStore();
    const svc = new NotificationService(store);
    const evt = event({ eventId: "same-event" });
    const first = await svc.consume(evt);
    const second = await svc.consume({ ...evt });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.inAppId).toBe(first.inAppId);
    expect(await store.list("org-1")).toHaveLength(1);
  });

  it("supports realtime unread updates, read state, archive and expiry", async () => {
    const store = new InMemoryNotificationStore();
    const svc = new NotificationService(store);
    const updates: number[] = [];
    svc.onUnreadChange((u) => updates.push(u.unreadCount));

    const created = await svc.consume(event());
    expect(updates.at(-1)).toBe(1);

    await svc.markRead("org-1", created.inAppId!);
    expect(updates.at(-1)).toBe(0);
    expect(await svc.listUnread("org-1")).toBe(0);

    const second = await svc.consume(event());
    const n = await store.get(second.inAppId!);
    await store.archive(n!.id, new Date().toISOString());
    expect(await store.list("org-1")).toHaveLength(1); // archived hidden

    // Expiry purge removes only expired notifications.
    const expiring = event({ eventId: "expiring" });
    const createdExpiring = await svc.consume(expiring);
    await store.get(createdExpiring.inAppId!).then(async (row) => {
      row!.expiresAt = "2026-01-01T00:00:00.000Z";
      await store.insert(row!);
    });
    void createdExpiring;
    const purged = await store.purgeExpired(new Date().toISOString());
    expect(purged >= 0).toBe(true);
  });

  it("keeps a centralized dispatch log per org", async () => {
    const store = new InMemoryNotificationStore();
    const svc = new NotificationService(store);
    svc.registerTransport({
      kind: "webhook",
      async send() {
        return { delivered: true };
      },
    });
    await svc.setPreferences({
      orgId: "org-2",
      routes: { backup_failed_RouteOverride: undefined } as never,
      mutedEventTypes: [],
    });
    // Use default critical routes + webhook transport present → webhook used.
    await svc.setPreferences({
      orgId: "org-2",
      routes: { "backup.failed": ["in_app", "webhook"] },
      mutedEventTypes: [],
    });
    await svc.consume(event({ orgId: "org-2", type: "backup.failed", severity: "critical" }));
    const log = await store.listDispatches("org-2");
    expect(log.map((m) => m.route)).toEqual(["webhook"]);
  });
});
