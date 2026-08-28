import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@mox/contracts";
import { useBrowser, useMox, useTerminal } from "../api/store.js";
import type { AgentSummary, ChatMessage, ComputerSnapshot } from "../api/types.js";
import { agentStatus, STATUS_LABEL } from "../domain/roster.js";
import { projectWorkView } from "../domain/work-view.js";
import { Avatar, Badge, Card } from "../ui/primitives.js";
import { Markdown } from "../ui/markdown.js";

export function AgentsView() {
  const mox = useMox();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => mox.agents.find((a) => a.definition.agentId === selectedId) ?? null,
    [mox.agents, selectedId],
  );

  return (
    <div>
      <h1>Agents</h1>
      <div className="agent-layout">
        <div className="agent-list">
          {mox.agents.map((a) => (
            <AgentRow
              key={a.definition.agentId}
              summary={a}
              active={a.definition.agentId === selectedId}
              onSelect={() => setSelectedId(a.definition.agentId)}
            />
          ))}
        </div>
        <div>{selected ? <AgentDetail summary={selected} /> : <Card>Select an agent to open its workspace.</Card>}</div>
      </div>
    </div>
  );
}

function AgentRow({
  summary,
  active,
  onSelect,
}: {
  summary: AgentSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const status = agentStatus(summary);
  const d = summary.definition;
  return (
    <div className={`agent-row ${active ? "active" : ""}`} onClick={onSelect} role="button" tabIndex={0}>
      <Avatar slug={d.slug} name={d.identity.displayName} status={status} />
      <div className="meta">
        <div className="name">
          <span>{d.identity.displayName}</span>
          {summary.hasUnread && <span className="unread-dot" />}
        </div>
        <div className="role">{d.identity.title ?? d.identity.role ?? STATUS_LABEL[status]}</div>
      </div>
    </div>
  );
}

const TABS = ["chat", "work", "computer", "files", "terminal", "logs", "settings"] as const;
type Tab = (typeof TABS)[number];

function AgentDetail({ summary }: { summary: AgentSummary }) {
  const mox = useMox();
  const terminalAllowed = useTerminal();
  const computerAllowed = useBrowser();
  const [tab, setTab] = useState<Tab>("chat");
  const agentId = summary.definition.agentId;
  // Real hosted thread lifecycle (Phase 02 §D): the server is the authority for
  // thread identity — no synthetic `t_<agentId>` ids.
  const [threads, setThreads] = useState<Array<{ threadId: string; title?: string }>>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const syncThreads = useCallback(
    async (prefer?: string) => {
      const list = await mox.api.listThreads(agentId);
      setThreads(list);
      if (list.length === 0) {
        setThreadId(null);
      } else {
        const chosen = prefer && list.some((t) => t.threadId === prefer) ? prefer : list[0]!.threadId;
        setThreadId(chosen);
      }
    },
    [mox, agentId],
  );

  useEffect(() => {
    void syncThreads();
  }, [agentId, syncThreads]);

  useEffect(() => {
    if (threadId) void mox.loadThread(agentId, threadId);
  }, [agentId, threadId, mox]);

  const newChat = async () => {
    setCreating(true);
    try {
      const created = await mox.api.createThread({ agentId, title: "New chat" });
      await syncThreads(created.threadId);
      setTab("chat");
    } finally {
      setCreating(false);
    }
  };

  const enabled: Record<Tab, boolean> = {
    chat: true,
    work: true,
    computer: computerAllowed && summary.definition.computer.enabled,
    files: true,
    terminal: terminalAllowed,
    logs: true,
    settings: true,
  };

  const status = agentStatus(summary);
  const d = summary.definition;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <Avatar slug={d.slug} name={d.identity.displayName} size={44} status={status} />
        <div>
          <h2 style={{ margin: 0 }}>{d.identity.displayName}</h2>
          <div className="muted">
            {d.identity.title} · {STATUS_LABEL[status]}
            {d.deployment.kind === "customer-vps" ? " · customer VPS" : " · Mox cloud"}
          </div>
        </div>
        <div className="spacer" />
        {summary.modelBadge && <Badge tone="accent">{summary.modelBadge}</Badge>}
        <button className="primary" onClick={newChat} disabled={creating}>
          {creating ? "Starting…" : "+ New Chat"}
        </button>
      </header>

      <nav className="tabs" aria-label="Agent sections">
        {TABS.map((t) => (
          <button key={t} disabled={!enabled[t]} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t[0]?.toUpperCase()}
            {t.slice(1)}
            {!enabled[t] ? " 🔒" : ""}
          </button>
        ))}
      </nav>

      {(tab === "chat" || tab === "work") && (
        <nav className="thread-list" aria-label="Threads">
          {(threadId ? threads : []).length === 0 ? (
            <span className="muted">No conversations yet.</span>
          ) : (
            threads.map((t) => (
              <button
                key={t.threadId}
                className={t.threadId === threadId ? "active" : ""}
                onClick={() => setThreadId(t.threadId)}
              >
                {t.title ?? "Chat"}
              </button>
            ))
          )}
        </nav>
      )}

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {tab === "chat" &&
          (threadId ? (
            <ChatTab agentId={agentId} threadId={threadId} name={d.identity.displayName} />
          ) : (
            <div className="empty" style={{ padding: 24 }}>
              <p>No conversation yet. Start a new chat to begin.</p>
              <button className="primary" onClick={newChat} disabled={creating}>
                {creating ? "Starting…" : "New Chat"}
              </button>
            </div>
          ))}
        {tab === "work" && threadId && <WorkTab subjectId={threadId} />}
        {tab === "computer" && <ComputerTab agentId={agentId} />}
        {tab === "files" && <FilesTab agentId={agentId} />}
        {tab === "terminal" && <TerminalTab agentId={agentId} />}
        {tab === "logs" && <LogsTab agentId={agentId} />}
        {tab === "settings" && <SettingsTab summary={summary} />}
      </div>
    </div>
  );
}

function ChatTab({ agentId, threadId, name }: { agentId: string; threadId: string; name: string }) {
  const mox = useMox();
  const messages = mox.messages(threadId);
  const runId = mox.activeRun(threadId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || runId) return;
    setDraft("");
    void mox.send(agentId, threadId, text);
  };

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <MessageBubble key={m.messageId} msg={m} agentName={name} onRetry={() => void mox.send(agentId, threadId, m.text)} />
        ))}
        {mox.approvals.length > 0 && <ApprovalCards />}
      </div>
      <div className="composer">
        <textarea
          value={draft}
          placeholder={`Message ${name}…`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {runId ? (
          <button className="danger" onClick={() => mox.cancel(runId)}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={submit} disabled={!draft.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  agentName,
  onRetry,
}: {
  msg: ChatMessage;
  agentName: string;
  onRetry: () => void;
}) {
  if (msg.role === "system") {
    return <div className="bubble system">{msg.text}</div>;
  }
  return (
    <div className={`bubble ${msg.role}`}>
      {msg.role === "agent" && <div className="who">{agentName}</div>}
      <Markdown text={msg.text} />
      {msg.streaming && <span className="caret" aria-label="streaming" />}
      {msg.error && (
        <div className="chat-error" style={{ marginTop: 8 }}>
          <span>⚠ {msg.error}</span>{" "}
          <button onClick={onRetry} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function ApprovalCards() {
  const mox = useMox();
  return (
    <>
      {mox.approvals.map((req) => (
        <div className="approval-card" key={req.approvalId}>
          <strong>Approval needed</strong>
          <div>{req.summary}</div>
          <div className="row">
            <button className="primary" onClick={() => void mox.resolveApproval(req.approvalId, "approved")}>
              Approve
            </button>
            <button className="danger" onClick={() => void mox.resolveApproval(req.approvalId, "denied")}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

export function WorkTab({ subjectId }: { subjectId: string }) {
  const mox = useMox();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => {
    let alive = true;
    void mox.api.getEvents(subjectId).then((evs) => {
      if (alive) setEvents(evs);
    });
    return () => {
      alive = false;
    };
  }, [subjectId, mox.api, mox.eventsVersion]);

  const items = projectWorkView(events);
  if (items.length === 0) return <Card>No runtime activity yet — activity appears as turns run.</Card>;
  return (
    <Card title="Activity (canonical runtime events)">
      {items.map((it) => (
        <div className="work-item" key={it.eventId}>
          <span className="work-kind">{it.kind}</span>
          <span>
            <strong className={it.ok === true ? "work-ok" : it.ok === false ? "work-fail" : undefined}>
              {it.title}
            </strong>
            {it.detail && (
              <div className="muted mono" style={{ fontSize: 12 }}>
                {it.detail}
              </div>
            )}
          </span>
        </div>
      ))}
    </Card>
  );
}

function ComputerTab({ agentId }: { agentId: string }) {
  const mox = useMox();
  const [snap, setSnap] = useState<ComputerSnapshot | undefined>();
  const refresh = () => void mox.api.computerSnapshot(agentId).then(setSnap);
  useEffect(refresh, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap) return <Card>No active computer session for this agent.</Card>;
  return (
    <Card
      title="Computer · via Mox Computer Gateway"
      actions={
        <div className="row-actions">
          <button onClick={() => void mox.api.computerRestart(agentId).then(setSnap)}>Restart session</button>
        </div>
      }
    >
      <div className="screen-frame">
        <div className="url">{snap.url}</div>
        <div>{snap.frameLabel}</div>
        <Badge tone={snap.state === "active" ? "good" : snap.state === "paused" ? "warn" : "neutral"}>
          session {snap.state}
        </Badge>
      </div>
      {snap.humanControl ? (
        <div className="taken-strip">
          You have control.{" "}
          <button onClick={() => void mox.api.computerTakeover(agentId, false, "u_you").then(setSnap)}>
            Hand back to agent
          </button>
        </div>
      ) : (
        <div className="row-actions" style={{ marginTop: 10 }}>
          <button onClick={() => void mox.api.computerTakeover(agentId, true, "u_you").then(setSnap)}>
            Take control
          </button>
          <span className="muted">Takeover pauses agent actions until you hand back.</span>
        </div>
      )}
    </Card>
  );
}

function FilesTab({ agentId }: { agentId: string }) {
  const mox = useMox();
  const [files, setFiles] = useState<Array<{ path: string; sizeBytes: number; updatedAt: string }>>([]);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    void mox.api.listFiles(agentId).then(setFiles);
  }, [agentId, mox.api]);
  return (
    <Card title="Workspace files">
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Size</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.path}>
              <td className="mono">{f.path}</td>
              <td>{Math.ceil(f.sizeBytes / 102.4) / 10} KB</td>
              <td>
                <button onClick={() => void mox.api.filePreview(agentId, f.path).then(setPreview)}>Preview</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview !== null && (
        <pre style={{ marginTop: 12 }}>
          <code>{preview}</code>
        </pre>
      )}
    </Card>
  );
}

function TerminalTab({ agentId }: { agentId: string }) {
  const mox = useMox();
  const [lines, setLines] = useState<string[]>([]);
  const [cmd, setCmd] = useState("");
  return (
    <Card title="Terminal (entitlement-gated)">
      <pre style={{ minHeight: 200 }}>
        <code>{lines.join("\n") || "# shell runs inside the agent's isolated container\n"}</code>
      </pre>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!cmd.trim()) return;
          const next = cmd.trim();
          setLines((prev) => [...prev, `$ ${next}`]);
          setCmd("");
          void mox.api
            .runTerminalCommand(agentId, next)
            .then((result) => setLines((prev) => [...prev, result.output || "(no output)"]))
            .catch((error) =>
              setLines((prev) => [
                ...prev,
                error instanceof Error ? error.message : String(error),
              ]),
            );
        }}
      >
        <input
          className="mono"
          style={{
            flex: 1, background: "var(--bg-raise)", color: "var(--text)",
            border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px",
          }}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="ls -la"
          aria-label="terminal command"
        />
        <button type="submit">Run</button>
      </form>
      <div className="muted" style={{ marginTop: 6 }}>
        Session scope: agent {agentId}. Audited by the policy engine.
      </div>
    </Card>
  );
}

function LogsTab({ agentId }: { agentId: string }) {
  const mox = useMox();
  const [logs, setLogs] = useState<Array<{ at: string; level: string; line: string }>>([]);
  useEffect(() => {
    void mox.api.getLogs(agentId).then(setLogs);
  }, [agentId, mox.api]);
  return (
    <Card title="Runtime logs">
      {logs.map((l, i) => (
        <div className="work-item" key={i}>
          <span className="work-kind">{l.level}</span>
          <span className="mono">{l.line}</span>
        </div>
      ))}
    </Card>
  );
}

function SettingsTab({ summary }: { summary: AgentSummary }) {
  const mox = useMox();
  const [models, setModels] = useState<Array<{ modelId: string; displayName: string; byok: boolean; available: boolean }>>([]);
  const d = summary.definition;
  useEffect(() => {
    void mox.api.listModels().then(setModels);
  }, [mox.api]);

  return (
    <Card title={`${d.identity.displayName} settings`}>
      <p>
        <strong>Role:</strong> {d.identity.role ?? "—"}
      </p>
      <p>
        <strong>Instructions:</strong> {d.instructions.text}
      </p>
      <p>
        <strong>Sandbox:</strong> {d.computer.sandbox} · <strong>Browser:</strong>{" "}
        {d.computer.allowBrowser ? "allowed" : "blocked"}
      </p>
      <label htmlFor="model-pick" style={{ display: "block", margin: "10px 0 6px" }}>
        Model
      </label>
      <select
        id="model-pick"
        value={summary.modelBadge}
        onChange={(e) => {
          void mox.api.updateModel(d.agentId, e.target.value).then(() => mox.invalidateEvents());
        }}
      >
        {models.map((m) => (
          <option key={m.modelId} value={m.modelId} disabled={!m.available}>
            {m.displayName}
            {!m.available ? " (not configured)" : m.byok ? " — BYOK" : ""}
          </option>
        ))}
      </select>
    </Card>
  );
}
