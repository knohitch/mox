import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@mox/contracts";
import { useBrowser, useDeveloperMode, useEntitlements, useMox, useTerminal } from "../api/store.js";
import type { AgentSummary, AgentVersionRow, ChatMessage, ComputerSnapshot, CreateAgentDraftInput, SimpleAgentInput } from "../api/types.js";
import { limitOf } from "../api/entitlement.js";
import { agentStatus, STATUS_LABEL } from "../domain/roster.js";
import { simpleInputFromDefinition, slugFromName } from "../domain/authoring.js";
import { projectWorkView } from "../domain/work-view.js";
import { Avatar, Badge, Button, Card, EmptyState, ErrorState } from "../ui/primitives.js";
import { Markdown } from "../ui/markdown.js";

export function AgentsView() {
  const mox = useMox();
  const entitlements = useEntitlements();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const selected = useMemo(
    () => mox.agents.find((a) => a.agentId === selectedId) ?? null,
    [mox.agents, selectedId],
  );

  // max_agents: a non-positive value (-1) means unlimited (the canonical
  // convention); absent value on demo means no limit.
  const maxAgents = limitOf(entitlements, "max_agents", Infinity);
  const atAgentLimit = maxAgents > 0 && mox.agents.length >= maxAgents;
  const drafts = mox.agents.filter((a) => a.status === "draft").length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0 }}>Agents</h1>
          <p className="page-sub" style={{ margin: "4px 0 0" }}>
            {mox.agents.length} agent{mox.agents.length === 1 ? "" : "s"}
            {drafts ? ` · ${drafts} draft${drafts === 1 ? "" : "s"} unpublished` : ""}
          </p>
        </div>
        <Button kind="primary" onClick={() => setShowNew(true)} disabled={atAgentLimit} title={atAgentLimit ? `Your plan allows ${maxAgents} agents.` : undefined}>
          + New Agent
        </Button>
      </div>
      <div className="agent-layout">
        <div className="agent-list">
          {mox.agents.map((a) => (
            <AgentRow
              key={a.agentId}
              summary={a}
              active={a.agentId === selectedId}
              onSelect={() => setSelectedId(a.agentId)}
            />
          ))}
        </div>
        <div>{selected ? <AgentDetail summary={selected} /> : <Card>Select an agent to open its workspace.</Card>}</div>
      </div>
      {showNew && <NewAgentModal onDone={async (agentId) => { await mox.refreshAgents(); setSelectedId(agentId ?? mox.agents[0]?.agentId ?? null); }} onClose={() => setShowNew(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New Agent (Phase 02 §B): Simple + Developer authoring modes feed the same
// canonical createAgentDraft seam; the server compiles/validates.
// ---------------------------------------------------------------------------

const TOOL_OPTIONS = [
  { toolName: "browse", label: "Browser" },
  { toolName: "code", label: "Code & repo" },
  { toolName: "terminal", label: "Terminal" },
  { toolName: "files", label: "Files & notes" },
  { toolName: "search", label: "Web search" },
] as const;

const PERMISSION_PRESET_OPTIONS: Array<{ value: SimpleAgentInput["permissionsPreset"]; label: string; hint: string }> = [
  { value: "safe", label: "Safe", hint: "approve computer, spend, external send & deploy" },
  { value: "balanced", label: "Balanced", hint: "approve spend & external send" },
  { value: "full", label: "Full access", hint: "allow-all · no human gates" },
];

function NewAgentModal({ onDone, onClose }: { onDone: (agentId?: string) => void; onClose: () => void }) {
  const mox = useMox();
  const developerMode = useDeveloperMode();
  const [mode, setMode] = useState<"simple" | "developer">("simple");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<Array<{ modelId: string; providerId: string; displayName: string; byok: boolean; available: boolean }>>([]);

  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [tools, setTools] = useState<Set<string>>(new Set(["browse"]));
  const [browser, setBrowser] = useState(true);
  const [preset, setPreset] = useState<SimpleAgentInput["permissionsPreset"]>("safe");
  const [target, setTarget] = useState<"sandbox" | "mox-cloud" | "customer-vps">("sandbox");
  const [raw, setRaw] = useState(
    JSON.stringify(
      {
        schemaVersion: 1,
        slug: "my-agent",
        identity: { displayName: "My Agent", role: "Assistant" },
        instructions: { text: "Help with my work." },
        model: { providerId: "p_openai", modelId: "gpt-4.1" },
        tools: { toolNames: ["browse"], integrations: [] },
        computer: { enabled: true, allowBrowser: true, sandbox: "container" },
        voice: { enabled: false },
        channels: [],
        deployment: { kind: "sandbox" },
        permissions: { toolPolicy: "default", requireApprovalFor: ["spend", "external-send"] },
        memory: { enabled: true, scope: "org" },
        schedules: [],
        workflows: [],
        subagents: [],
        authoring: { mode: "developer" },
        metadata: {},
      },
      null,
      2,
    ),
  );

  useEffect(() => {
    void mox.api.listModels().then((ms) => {
      setModels(ms);
      const first = ms.find((m) => m.available);
      if (first && !model) setModel(`${first.providerId}/${first.modelId}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mox.api]);

  const slugBy = slugFromName(name);
  const submit = async () => {
    setError(null);
    let input: CreateAgentDraftInput;
    if (mode === "developer") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        setError("Developer mode requires valid JSON.");
        return;
      }
      input = { mode: "developer", slug: (JSON.parse(raw) as { slug?: string })?.slug ?? slugBy ?? "dev-agent", raw: parsed };
    } else {
      if (!name.trim()) {
        setError("Enter a name for the agent.");
        return;
      }
      input = {
        mode: "simple",
        slug: slugBy ?? "agent",
        input: {
          displayName: name.trim(),
          role: role.trim() || undefined,
          instructions: instructions.trim(),
          model,
          toolNames: [...tools],
          browserEnabled: browser,
          permissionsPreset: preset,
          target:
            target === "sandbox"
              ? { kind: "sandbox" }
              : target === "mox-cloud"
                ? { kind: "mox-cloud", region: "eu-central" }
                : { kind: "customer-vps", vpsId: "srv_demo" },
        },
      };
    }
    setBusy(true);
    try {
      const result = await mox.api.createAgentDraft(input);
      onDone(result.agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="New Agent" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>New Agent</h3>
          <Button kind="ghost" size="sm" onClick={onClose}>✕</Button>
        </header>
        <nav className="tabs" aria-label="Authoring mode">
          <button className={mode === "simple" ? "active" : ""} onClick={() => setMode("simple")}>Simple</button>
          <button
            className={mode === "developer" ? "active" : ""}
            disabled={!developerMode}
            onClick={() => setMode("developer")}
            title={developerMode ? undefined : "Developer mode is not enabled on your plan"}
          >
            Developer{!developerMode ? " 🔒" : ""}
          </button>
        </nav>

        {mode === "simple" ? (
          <div className="form-grid">
            <label className="form-field">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Research assistant" autoFocus />
            </label>
            <label className="form-field">
              Role
              <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Analyst" />
            </label>
            <label className="form-field form-field-wide">
              Instructions
              <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder="What should the agent do?" />
            </label>
            <label className="form-field">
              Model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m.modelId} value={`${m.providerId}/${m.modelId}`} disabled={!m.available}>
                    {m.displayName}
                    {!m.available ? " (not configured)" : m.byok ? " — BYOK" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              Tools
              <span className="tool-grid">
                {TOOL_OPTIONS.map((t) => (
                  <label key={t.toolName} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    <input type="checkbox" checked={tools.has(t.toolName)} onChange={() => setTools((prev) => { const next = new Set(prev); if (next.has(t.toolName)) next.delete(t.toolName); else next.add(t.toolName); return next; })} />
                    {t.label}
                  </label>
                ))}
              </span>
            </label>
            <label className="form-field">
              Permission preset
              <select value={preset} onChange={(e) => setPreset(e.target.value as SimpleAgentInput["permissionsPreset"])}>
                {PERMISSION_PRESET_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label} · {p.hint}</option>
                ))}
              </select>
            </label>
            <label className="form-field">
              Target
              <select value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
                <option value="sandbox">Sandbox</option>
                <option value="mox-cloud">Mox cloud</option>
                <option value="customer-vps">Customer VPS</option>
              </select>
            </label>
            <label className="form-field" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} />
              Enable browser / computer use
            </label>
          </div>
        ) : (
          <div>
            <p className="muted" style={{ fontSize: 12.5 }}>
              Paste a canonical <span className="mono">AgentDefinition</span>. Fields are validated by the server — org{" "}
              <span className="mono">orgId</span>, <span className="mono">agentId</span> seeds and timestamps are minted
              server-side. Slug is taken from the definition.
            </p>
            <textarea className="mono dev-editor" value={raw} onChange={(e) => setRaw(e.target.value)} rows={14} spellCheck={false} />
          </div>
        )}

        {error ? <ErrorState message={error} /> : null}
        <footer className="modal-foot">
          <span className="muted" style={{ fontSize: 12.5 }}>Drafts are compiled but stay unpublished until you click Publish.</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button kind="primary" onClick={() => void submit()} disabled={busy}>{busy ? "Saving…" : "Create draft"}</Button>
          </div>
        </footer>
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
  const isDraft = summary.status === "draft";
  return (
    <div className={`agent-row ${active ? "active" : ""}`} onClick={onSelect} role="button" tabIndex={0}>
      <Avatar slug={d.slug} name={d.identity.displayName} status={isDraft ? undefined : status} />
      <div className="meta">
        <div className="name">
          <span>{d.identity.displayName}</span>
          {isDraft ? <Badge tone="warn">draft</Badge> : summary.currentVersion ? <Badge tone="accent">v{summary.currentVersion}</Badge> : null}
          {summary.hasUnread && <span className="unread-dot" />}
        </div>
        <div className="role">{isDraft ? "Unpublished draft" : (d.identity.title ?? d.identity.role ?? STATUS_LABEL[status])}</div>
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
  // The summary's `agentId` is the server-authoritative row id — the SAME id
  // the hosted thread routes address agents by (see AgentSummary doc). Never
  // fall back to `definition.agentId` (engine-facing, ≠ row id on hosted).
  const agentId = summary.agentId;
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
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const refresh = () => {
    setUnavailable(null);
    void mox.api
      .computerSnapshot(agentId)
      .then(setSnap)
      .catch((e) => setUnavailable(e instanceof Error ? e.message : String(e)));
  };
  useEffect(refresh, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (unavailable) {
    return (
      <FeatureUnavailable
        label="Computer"
        reason={`${unavailable} — the computer gateway is not configured for this workspace. No session is streamed.`}
      />
    );
  }
  if (!snap) return <FeatureUnavailable label="Computer" reason="No active computer session for this agent yet." />;
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
  const [unavailable, setUnavailable] = useState<string | null>(null);
  useEffect(() => {
    void mox.api
      .listFiles(agentId)
      .then(setFiles)
      .catch((e) => setUnavailable(e instanceof Error ? e.message : String(e)));
  }, [agentId, mox.api]);
  if (unavailable) {
    return (
      <FeatureUnavailable
        label="Workspace files"
        reason={`${unavailable} — file sync is not configured for this workspace, so no agent files are surfaced.`}
      />
    );
  }
  return (
    <Card title="Workspace files">
      {files.length === 0 ? (
        <EmptyState>No synced files.</EmptyState>
      ) : (
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
      )}
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
  const [unavailable, setUnavailable] = useState<string | null>(null);
  if (unavailable) {
    return (
      <FeatureUnavailable
        label="Terminal"
        reason={`${unavailable} — the runtime terminal is not configured for this workspace. Terminal egress stays fail-closed; nothing is run.`}
      />
    );
  }
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
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              setLines((prev) => [...prev, `! ${message}`]);
              if (/not_configured|not configured|501/i.test(message)) {
                setUnavailable(message);
              }
            });
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
  const [unavailable, setUnavailable] = useState<string | null>(null);
  useEffect(() => {
    void mox.api
      .getLogs(agentId)
      .then(setLogs)
      .catch((e) => setUnavailable(e instanceof Error ? e.message : String(e)));
  }, [agentId, mox.api]);
  if (unavailable) {
    return <FeatureUnavailable label="Runtime logs" reason={`${unavailable} — log streaming is not configured for this workspace.`} />;
  }
  return (
    <Card title="Runtime logs">
      {logs.length === 0 ? <EmptyState>No log output yet.</EmptyState> : null}
      {logs.map((l, i) => (
        <div className="work-item" key={i}>
          <span className="work-kind">{l.level}</span>
          <span className="mono">{l.line}</span>
        </div>
      ))}
    </Card>
  );
}

/**
 * Honest unavailable state (Phase 02 §F): capabilities served by routes that
 * are not configured report 501 from the control plane — the UI renders that
 * as an explicit "not configured" rather than an empty surface or a crash.
 */
function FeatureUnavailable({ label, reason }: { label: string; reason: string }) {
  return (
    <Card title={label}>
      <div className="notice">
        <strong>Not configured.</strong> {reason}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Versions (Phase 02 §C) + Settings (Phase 02 §J): the server is the single
// source of truth for the working-copy definition and its published history.
// Simple-mode round-tripping lives in domain/authoring.ts (shared with tests).
// ---------------------------------------------------------------------------

function SettingsTab({ summary }: { summary: AgentSummary }) {
  const mox = useMox();
  const d = summary.definition;
  const isDraft = summary.status === "draft";
  const simpleMode = d.authoring.mode === "simple";
  const [models, setModels] = useState<Array<{ modelId: string; providerId: string; displayName: string; byok: boolean; available: boolean }>>([]);
  const [versions, setVersions] = useState<AgentVersionRow[]>([]);
  const [changelog, setChangelog] = useState("");
  const [role, setRole] = useState(d.identity.role ?? "");
  const [instructions, setInstructions] = useState(d.instructions.text);
  const [preset, setPreset] = useState<SimpleAgentInput["permissionsPreset"]>(simpleInputFromDefinition(d).permissionsPreset);
  const [browser, setBrowser] = useState(d.computer.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void mox.api.listModels().then(setModels);
    void mox.api.listAgentVersions(summary.agentId).then(setVersions).catch(() => setVersions([]));
  }, [mox.api, summary.agentId]);

  const log = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const saveDraft = async () => {
    setError(null);
    setBusy(true);
    try {
      const current = simpleInputFromDefinition(summary.definition);
      await mox.api.updateAgentDraft(summary.agentId, {
        mode: "simple",
        slug: summary.definition.slug,
        input: { ...current, role: role.trim() || undefined, instructions, browserEnabled: browser, permissionsPreset: preset },
      });
      setDirty(false);
      await mox.refreshAgents();
      setVersions(await mox.api.listAgentVersions(summary.agentId));
    } catch (err) {
      log(err);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setError(null);
    setBusy(true);
    try {
      await mox.api.publishAgent(summary.agentId, changelog.trim() || undefined);
      setChangelog("");
      setDirty(false);
      await mox.refreshAgents();
      setVersions(await mox.api.listAgentVersions(summary.agentId));
    } catch (err) {
      log(err);
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (toRevision: number) => {
    if (!window.confirm(`Roll back ${d.identity.displayName} to revision v${toRevision}? The working copy is discarded.`)) return;
    setError(null);
    setBusy(true);
    try {
      await mox.api.rollbackAgent(summary.agentId, toRevision);
      await mox.refreshAgents();
      setVersions(await mox.api.listAgentVersions(summary.agentId));
    } catch (err) {
      log(err);
    } finally {
      setBusy(false);
    }
  };

  const updateModelNow = (value: string) => {
    setError(null);
    void mox.api
      .updateModel(summary.agentId, value)
      .then(() => mox.refreshAgents())
      .then(() => mox.invalidateEvents())
      .catch(log);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card title="Versions" actions={isDraft ? <Badge tone="warn">unpublished draft</Badge> : <Badge tone="good">v{summary.currentVersion ?? versions.at(-1)?.revision ?? 0} live</Badge>}>
        {versions.length === 0 ? (
          <EmptyState>No published versions yet. Publish to make the current definition live.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Rev</th><th>Changelog</th><th>By</th><th>At</th><th /></tr>
              </thead>
              <tbody>
                {[...versions].reverse().map((v, i) => (
                  <tr key={v.revision}>
                    <td><Badge tone={v.revision === summary.currentVersion ? "good" : "neutral"}>v{v.revision}</Badge></td>
                    <td>{v.changelog ?? "—"}</td>
                    <td className="mono">{v.createdBy}</td>
                    <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
                    <td>
                      {v.revision !== summary.currentVersion ? (
                        <Button size="sm" disabled={busy} onClick={() => void rollback(v.revision)}>Rollback</Button>
                      ) : (
                        <span className="muted">live</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <input
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
            placeholder="Changelog for this release (optional)"
            style={{ flex: 1 }}
            aria-label="publish changelog"
          />
          <Button kind="primary" disabled={busy} onClick={() => void publish()}>
            {isDraft ? "Publish" : "Publish new version"}
          </Button>
        </div>
      </Card>

      <Card title="Settings">
        {!simpleMode && (
          <p className="muted" style={{ fontSize: 12.5, maxWidth: 72 }}>
            This agent was authored in Developer mode — the raw definition is edited
            through the API/CLI. Inline Simple-mode editing is disabled; model stays
            switchable.
          </p>
        )}
        {simpleMode ? (
          <>
            <div className="form-grid">
              <label className="form-field">
                Role
                <input value={role} onChange={(e) => { setRole(e.target.value); setDirty(true); }} />
              </label>
              <label className="form-field">
                Permission preset
                <select value={preset} onChange={(e) => { setPreset(e.target.value as SimpleAgentInput["permissionsPreset"]); setDirty(true); }}>
                  {PERMISSION_PRESET_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label} · {p.hint}</option>
                  ))}
                </select>
              </label>
              <label className="form-field form-field-wide">
                Instructions
                <textarea value={instructions} rows={4} onChange={(e) => { setInstructions(e.target.value); setDirty(true); }} />
              </label>
              <label className="form-field form-field-wide" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={browser} onChange={(e) => { setBrowser(e.target.checked); setDirty(true); }} />
                Enable browser / computer use
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button kind="primary" disabled={busy || !dirty} onClick={() => void saveDraft()}>
                {busy ? "Saving…" : "Save draft"}
              </Button>
              {dirty && <span className="muted" style={{ alignSelf: "center", fontSize: 12.5 }}>Unpublished working-copy changes.</span>}
            </div>
          </>
        ) : (
          <p>
            <strong>Sandbox:</strong> {d.computer.sandbox} · <strong>Browser:</strong>{" "}
            {d.computer.allowBrowser ? "allowed" : "blocked"}
          </p>
        )}

        <label htmlFor="model-pick" style={{ display: "block", margin: "14px 0 6px" }}>
          Model
        </label>
        <select
          id="model-pick"
          value={`${d.model.providerId}/${d.model.modelId}`}
          onChange={(e) => updateModelNow(e.target.value)}
          disabled={busy}
        >
          {models.map((m) => (
            <option key={m.modelId} value={`${m.providerId}/${m.modelId}`} disabled={!m.available}>
              {m.displayName}
              {!m.available ? " (not configured)" : m.byok ? " — BYOK" : ""}
            </option>
          ))}
        </select>
        {error ? <ErrorState message={error} /> : null}
      </Card>
    </div>
  );
}
