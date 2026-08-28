import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMox } from "../api/store.js";
import type { NotificationItem } from "../api/notification-types.js";

const CATEGORIES = ["all", "unread", "system", "billing", "servers", "agents", "security"] as const;
type Filter = (typeof CATEGORIES)[number];

const PAGE_SIZE = 25;

/** Header bell with live unread count (Prompt 02 §User web UI). */
export function NotificationBell(): ReactNode {
  const { httpApi } = useMoxApi();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!httpApi) return;
    try {
      const res = await httpApi.unreadCount();
      setCount(res.count);
    } catch {
      // transient; next poll retries
    }
  }, [httpApi]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="bell-wrap">
      <button
        type="button"
        className="bell"
        aria-label={`Notifications (${count} unread)`}
        onClick={() => {
          setOpen(!open);
          void refresh();
        }}
      >
        🔔
        {count > 0 ? <span className="bell-badge">{count > 99 ? "99+" : count}</span> : null}
      </button>
      {open ? (
        <InboxPanel
          onAnyChange={() => void refresh()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function useMoxApi() {
  const ctx = useMox();
  // The composed HttpMoxApi instance carries notification helpers.
  const httpApi = (ctx.api as unknown as { constructor?: { name: string } }) &&
    "unreadCount" in ctx.api
    ? (ctx.api as Extract<typeof ctx.api, { unreadCount: unknown }>)
    : undefined;
  return { ...ctx, httpApi: httpApi as import("../api/http-api.js").HttpMoxApi | undefined };
}

/** Inbox panel: filters, actions, pagination. */
export function InboxPanel(props: { onAnyChange: () => void; onClose: () => void }): ReactNode {
  const { httpApi } = useMoxApi();
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const query = useMemo(
    () => ({
      unread: filter === "unread",
      category: CATEGORIES.includes(filter as never) && !["all", "unread"].includes(filter) ? filter : undefined,
      limit: PAGE_SIZE + 1,
      offset,
    }),
    [filter, offset],
  );

  const load = useCallback(async () => {
    if (!httpApi) return;
    setLoading(true);
    try {
      const rows = await httpApi.listNotifications(query);
      setHasMore(rows.length > PAGE_SIZE);
      setItems((prev) => (offset === 0 ? rows.slice(0, PAGE_SIZE) : [...prev, ...rows.slice(0, PAGE_SIZE)]));
    } finally {
      setLoading(false);
    }
  }, [httpApi, query, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<void>) => {
    await fn();
    if (offset === 0) await load();
    props.onAnyChange();
  };

  return (
    <div className="inbox" role="dialog" aria-label="Notification inbox">
      <div className="inbox-head">
        <select value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setOffset(0); }}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c === "all" ? "All" : c[0]!.toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => act(() => httpApi!.markAllNotificationsRead().then())}>
          Mark all read
        </button>
        <a href="/settings#notifications" className="linklike" onClick={props.onClose} title="Notification Preferences" style={{ textDecoration: "none", fontSize: 14 }}>
          ⚙
        </a>
        <button type="button" className="linklike" onClick={props.onClose}>
          ✕
        </button>
      </div>

      {loading && items.length === 0 ? <p className="muted">Loading…</p> : null}
      {!loading && items.length === 0 ? <p className="muted">You're all caught up.</p> : null}

      <ul className="inbox-list">
        {items.map((n) => (
          <li key={n.id} className={`inbox-item ${n.readAt ? "read" : "unread"} sev-${n.severity}`}>
            <div className="inbox-item-main">
              <strong>{n.title}</strong>
              <span className="muted">{new Date(n.createdAt).toLocaleString()}</span>
              <p>{n.body}</p>
            </div>
            <div className="inbox-item-actions">
              {n.readAt ? (
                <button type="button" onClick={() => act(() => httpApi!.markNotificationUnread(n.id))}>
                  Mark unread
                </button>
              ) : (
                <button type="button" onClick={() => act(() => httpApi!.markNotificationRead(n.id))}>
                  Mark read
                </button>
              )}
              <button type="button" onClick={() => act(() => httpApi!.archiveNotification(n.id))}>
                Archive
              </button>
            </div>
          </li>
        ))}
      </ul>

      {hasMore ? (
        <button type="button" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={loading}>
          Load more
        </button>
      ) : null}
    </div>
  );
}
