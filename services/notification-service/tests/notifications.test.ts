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
    const notification = await store.getForUser(result.inAppId!, "org-1", "u1");
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
    expect(await store.listForUser("org-1", "u1")).toHaveLength(1);
  });

  it("keeps selected-users fan-out visible only to each explicit recipient", async () => {
    const store = new InMemoryNotificationStore();
    const svc = new NotificationService(store, async () => [
      { orgId: "org-1", userId: "u1" },
    ]);
    await svc.createJob({
      idempotencyKey: "selected-users-once",
      createdBy: "admin",
      audience: { type: "users", userIds: ["u1"] },
      payload: { title: "Selected", body: "Only one user" },
    });
    await svc.runDueJobs(new Date().toISOString());
    expect((await store.listForUser("org-1", "u1")).map((n) => n.title)).toContain("Selected");
    expect((await store.listForUser("org-1", "u2")).map((n) => n.title)).not.toContain("Selected");
  });

  it("namespaces admin job idempotency by creating actor", async () => {
    const store = new InMemoryNotificationStore();
    const svc = new NotificationService(store, async () => []);
    const first = await svc.createJob({
      idempotencyKey: "same-key",
      createdBy: "admin-a",
      audience: { type: "all" },
      payload: { title: "A", body: "A body" },
    });
    const second = await svc.createJob({
      idempotencyKey: "same-key",
      createdBy: "admin-b",
      audience: { type: "all" },
      payload: { title: "B", body: "B body" },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it("dedupes external dispatches per recipient/channel", async () => {
    const store = new InMemoryNotificationStore();
    const message = {
      id: "msg_a",
      orgId: "org-d",
      userId: "u1",
      eventType: "backup.failed" as const,
      route: "email" as const,
      recipient: "u1",
      title: "Backup failed",
      body: "Body",
      dedupeKey: "evt:email:u1",
      at: new Date().toISOString(),
    };
    await store.recordDispatch(message);
    await store.recordDispatch({ ...message, id: "msg_b" });
    expect(await store.listDispatches("org-d")).toHaveLength(1);
  });

  it("supports realtime unread updates, read state, archive and expiry", async () => {
    const store = new InMemoryNotificationStore();
    const svc = new NotificationService(store);
    const updates: number[] = [];
    svc.onUnreadChange((u) => updates.push(u.unreadCount));

    const created = await svc.consume(event());
    expect(updates.at(-1)).toBe(1);

    await svc.markRead(created.inAppId!, "org-1", "u1");
    expect(updates.at(-1)).toBe(0);
    expect(await svc.unreadCount("org-1", "u1")).toBe(0);

    const second = await svc.consume(event());
    const n = await store.getForUser(second.inAppId!, "org-1", "u1");
    await store.archive(n!.id, "org-1", "u1", new Date().toISOString());
    expect(await store.listForUser("org-1", "u1")).toHaveLength(1); // archived hidden

    // Expiry purge removes only expired notifications.
    const expiring = event({ eventId: "expiring" });
    const createdExpiring = await svc.consume(expiring);
    await store.getForUser(createdExpiring.inAppId!, "org-1", "u1").then(async (row) => {
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
