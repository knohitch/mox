import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentId, SubagentRef } from "@mox/contracts";
import { useBrowser, useDeveloperMode, useEntitlements, useMox, useTerminal } from "../api/store.js";
import { Link } from "../router.js";


import type {
  AgentSummary,
  AgentVersionRow,
  ChatMessage,
  ComputerSnapshot,
  CreateAgentDraftInput,
  KnowledgeSourceItem,
  SimpleAgentInput,
  VoiceOption,
} from "../api/types.js";


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
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState("");
  const [recentThreads, setRecentThreads] = useState<Array<{ threadId: string; title?: string; agentId: string; agentName: string; }>>([]);
  
  const selected = useMemo(
    () => mox.agents.find((a) => a.agentId === selectedId) ?? null,
    [mox.agents, selectedId],
  );

  const syncAllThreads = useCallback(async () => {
    const all = await Promise.all(mox.agents.map(async (a) => {
      const list = await mox.api.listThreads(a.agentId);
      return list.map(t => ({ ...t, agentId: a.agentId, agentName: a.definition.identity.displayName }));
    }));
    setRecentThreads(all.flat());
  }, [mox.agents, mox.api]);

  useEffect(() => {
    void syncAllThreads();
  }, [syncAllThreads]);

  const maxAgents = limitOf(entitlements, "max_agents", Infinity);
  const atAgentLimit = maxAgents > 0 && mox.agents.length >= maxAgents;

  const filteredAgents = useMemo(() => {
    if (!search) return mox.agents;
    const lower = search.toLowerCase();
    return mox.agents.filter((a) => a.definition.identity.displayName.toLowerCase().includes(lower) || a.definition.slug.toLowerCase().includes(lower));
  }, [mox.agents, search]);

  const filteredThreads = useMemo(() => {
    if (!search) return recentThreads;
    const lower = search.toLowerCase();
    return recentThreads.filter((t) => (t.title || "New chat").toLowerCase().includes(lower) || t.agentName.toLowerCase().includes(lower));
  }, [recentThreads, search]);

  const gradients = [
    "linear-gradient(135deg, rgba(59, 130, 246, 0.5), rgba(139, 92, 246, 0.5))",
    "linear-gradient(135deg, rgba(245, 158, 11, 0.5), rgba(239, 68, 68, 0.5))",
    "linear-gradient(135deg, rgba(16, 185, 129, 0.5), rgba(59, 130, 246, 0.5))",
    "linear-gradient(135deg, rgba(236, 72, 153, 0.5), rgba(139, 92, 246, 0.5))",
    "linear-gradient(135deg, rgba(6, 182, 212, 0.5), rgba(59, 130, 246, 0.5))",
  ];

  return (
    <div className="aw-workspace">
      {/* Left Rail */}
      <div className="aw-sidebar">
        <div className="aw-sidebar-header">
          <div className="aw-sidebar-title">Mox Agents</div>
          <button className="aw-sidebar-new" onClick={() => setShowNew(true)} title="New Agent" disabled={atAgentLimit}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
        </div>
        <div className="aw-search-box">
          <svg className="aw-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            className="aw-search-input"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="aw-sidebar-list">
          {recentThreads.length > 0 && (
            <div className="aw-rail-section">
              <div className="aw-rail-heading">Recent</div>
              {filteredThreads.map((t) => (
                <div
                  key={t.threadId}
                  className={`aw-thread-row ${t.agentId === selectedId && t.threadId === selectedThreadId ? "active" : ""}`}
                  onClick={() => { setSelectedId(t.agentId); setSelectedThreadId(t.threadId); }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="aw-thread-row-title">{t.title || "New chat"}</div>
                  <div className="aw-thread-row-sub">{t.agentName}</div>
                </div>
              ))}
            </div>
          )}
          <div className="aw-rail-section">
            <div className="aw-rail-heading">Agents</div>
            {filteredAgents.map((a, i) => (
              <div
                key={a.agentId}
                className={`aw-agent-row ${a.agentId === selectedId && !selectedThreadId ? "active" : ""}`}
                onClick={() => { setSelectedId(a.agentId); setSelectedThreadId(null); }}
                role="button"
                tabIndex={0}
              >
                <div className="aw-agent-row-icon" style={{ background: gradients[i % gradients.length] }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
                </div>
                <div className="aw-agent-row-content">
                  <div className="aw-agent-row-top">
                    <span className="aw-agent-row-title">{a.definition.identity.displayName}</span>
                  </div>
                  <div className="aw-agent-row-sub">{a.status === "draft" ? "Draft" : "Active"}</div>
                </div>
              </div>
            ))}
            {filteredAgents.length === 0 && (
              <div className="muted" style={{ padding: "20px", textAlign: "center", fontSize: 12 }}>
                No agents found.
              </div>
            )}
          </div>
        </div>
        <div className="aw-sidebar-footer">
          <div className="aw-rail-section" style={{ paddingBottom: 0 }}>
            <div className="aw-rail-heading">Workspace</div>
            <Link to="/rooms" className="aw-sidebar-footer-item">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
              Agent Rooms
            </Link>
            <a href="#" className="aw-sidebar-footer-item" onClick={(e) => { e.preventDefault(); setShowNew(true); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              Create Agent
            </a>
          </div>
        </div>
      </div>

      {/* Main Area */}
      <div className="aw-main">
        {selected ? (
          <AgentDetail 
            summary={selected} 
            threadId={selectedThreadId}
            onThreadChange={setSelectedThreadId}
            onNewChat={async () => {
               const created = await mox.api.createThread({ agentId: selected.agentId, title: "New chat" });
               await syncAllThreads();
               setSelectedThreadId(created.threadId);
            }}
            onBack={() => { setSelectedId(null); setSelectedThreadId(null); }} 
          />
        ) : (
          <div className="aw-hub">
            <div className="aw-hub-title">MOX WORKSPACE</div>
            <div className="aw-hub-heading">Start a new conversation</div>

            <div className="aw-composer-wrapper">
              <textarea
                className="aw-composer"
                placeholder="Ask anything..."
                disabled
              />
              <button className="aw-composer-submit" disabled>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
              </button>
            </div>
            

            {mox.agents.length > 0 ? (
              <div className="aw-explore-section">
                <div className="aw-explore-heading">Explore agents</div>
                <div className="aw-agent-grid">
                  {mox.agents.map((a, i) => (
                    <div
                      key={a.agentId}
                      className="aw-agent-card"
                      onClick={() => setSelectedId(a.agentId)}
                      style={{ background: gradients[i % gradients.length] }}
                    >
                      <div className="aw-agent-card-inner">
                        <div className="aw-agent-card-title">{a.definition.identity.displayName}</div>
                        <div className="aw-agent-card-desc">{a.definition.instructions.text || "Help with everyday work using clear, concise, and accurate responses."}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ textAlign: "center", color: "#94a3b8", marginTop: 40 }}>
                <p>No agents available in this workspace.</p>
                <Button kind="primary" onClick={() => setShowNew(true)}>Create your first agent</Button>
              </div>
            )}
          </div>
        )}
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


const TABS = ["chat", "work", "computer", "files", "terminal", "logs", "settings"] as const;
type Tab = (typeof TABS)[number];

function AgentDetail({ summary, threadId, onBack, onThreadChange, onNewChat }: { summary: AgentSummary; threadId: string | null; onBack?: () => void; onThreadChange: (id: string) => void; onNewChat: () => Promise<void> }) {
  const mox = useMox();
  const terminalAllowed = useTerminal();
  const computerAllowed = useBrowser();
  const [tab, setTab] = useState<Tab>("chat");
  const agentId = summary.agentId;
  
  
  const [creating, setCreating] = useState(false);

  
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
    <div className="agent-layout">
      <header className="aw-chat-header">
        <div className="aw-chat-title">
          {onBack && (
            <button className="aw-back-btn" onClick={onBack}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
          )}
          <Avatar slug={d.slug} name={d.identity.displayName} size={32} status={status} />
          <h2>{d.identity.displayName}</h2>
        </div>
        <div className="aw-chat-actions">
          <button className="aw-action-btn" onClick={onNewChat} disabled={creating}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Task
          </button>
          
          {summary.modelBadge && (
            <div className="aw-model-badge">
              {summary.modelBadge}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
          )}

          <div className="aw-action-icons">
            <button className={`aw-icon-btn ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab("chat")} title="Chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            </button>
            {enabled.work && (
              <button className={`aw-icon-btn ${tab === 'work' ? 'active' : ''}`} onClick={() => setTab("work")} title="Work">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>
              </button>
            )}
            {enabled.computer && (
              <button className={`aw-icon-btn ${tab === 'computer' ? 'active' : ''}`} onClick={() => setTab("computer")} title="Computer">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              </button>
            )}
            {enabled.files && (
              <button className={`aw-icon-btn ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab("files")} title="Files">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
              </button>
            )}
            {enabled.terminal && (
              <button className={`aw-icon-btn ${tab === 'terminal' ? 'active' : ''}`} onClick={() => setTab("terminal")} title="Terminal">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
              </button>
            )}
            {enabled.logs && (
              <button className={`aw-icon-btn ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab("logs")} title="Logs">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
              </button>
            )}
            {enabled.settings && (
              <button className={`aw-icon-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab("settings")} title="Settings">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0 .33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="aw-chat-container">

        <div style={{ flex: 1, overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {tab === "chat" &&
            (threadId ? (
              <ChatTab agentId={agentId} threadId={threadId} name={d.identity.displayName} summary={summary} />
            ) : (
              <div className="aw-empty-thread">
                <Avatar slug={d.slug} name={d.identity.displayName} size={64} status={status} />
                <h2>{d.identity.displayName}</h2>
                <p>Ready when you are.<br/>Ask this agent to research, analyze, compare, or investigate something.</p>
                <div className="aw-suggestions">
                  <button onClick={() => void 0}>Research a market</button>
                  <button onClick={() => void 0}>Analyze a document</button>
                  <button onClick={() => void 0}>Compare competitors</button>
                  <button onClick={() => void 0}>Build a research brief</button>
                </div>
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
    </div>
  );
}

function ChatTab({ agentId, threadId, name, summary }: { agentId: string; threadId: string; name: string; summary?: AgentSummary }) {
  const mox = useMox();
  const messages = mox.messages(threadId);
  const runId = mox.activeRun(threadId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  useEffect(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    if (!isScrolledUp) {
      scrollRef.current.scrollTo({ top: scrollHeight });
    }
  }, [messages, isScrolledUp]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isUp = scrollHeight - scrollTop - clientHeight > 50;
    setIsScrolledUp(isUp);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || runId) return;
    setDraft("");
    setIsScrolledUp(false); // force scroll to bottom on send
    void mox.send(agentId, threadId, text);
  };

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 && summary && (
          <div className="aw-empty-thread">
            <Avatar slug={summary.definition.slug} name={summary.definition.identity.displayName} size={64} status={agentStatus(summary)} />
            <h2>{summary.definition.identity.displayName}</h2>
            <p>Ready when you are.<br/>Ask this agent to research, analyze, compare, or investigate something.</p>
            <div className="aw-suggestions">
              <button onClick={() => { setDraft("Research a market"); }}>Research a market</button>
              <button onClick={() => { setDraft("Analyze a document"); }}>Analyze a document</button>
              <button onClick={() => { setDraft("Compare competitors"); }}>Compare competitors</button>
              <button onClick={() => { setDraft("Build a research brief"); }}>Build a research brief</button>
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.messageId} msg={m} agentName={name} onRetry={() => void mox.send(agentId, threadId, m.text)} />
        ))}
        {mox.approvals.length > 0 && <ApprovalCards />}
      </div>
      <div className="aw-composer-container">
        <div className="aw-composer-wrapper active-composer">
          <textarea
            className="aw-composer"
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
          <div className="aw-composer-toolbar">
            <div className="aw-composer-tools">
              <button className="aw-icon-btn" title="Add context">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
            </div>
            {runId ? (
              <button className="aw-composer-stop" onClick={() => mox.cancel(runId)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"></rect></svg>
              </button>
            ) : (
              <button className="aw-composer-submit" onClick={submit} disabled={!draft.trim()}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
              </button>
            )}
          </div>
        </div>
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

export const REGISTERED_SKILLS = [
  { id: "data_analysis", label: "Data Analysis", description: "Statistical computation, tabular analytics, and chart generation" },
  { id: "web_search", label: "Web Search", description: "Web querying, link extraction, and web search retrieval" },
  { id: "code_interpreter", label: "Code Interpreter", description: "Isolated Python code execution environment" },
  { id: "sql_query", label: "SQL Query Engine", description: "Database schema inspection and SQL formulation" },
  { id: "doc_summarizer", label: "Document Summarizer", description: "Multi-page text distillation and executive takeaways" },
] as const;

function SettingsTab({ summary }: { summary: AgentSummary }) {
  const mox = useMox();
  const ents = useEntitlements();
  const caps = ents?.values ?? {};
  const schedLimit = typeof caps.schedule_workflow_limit === "number" ? caps.schedule_workflow_limit : 5;

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

  // Extended capability states (Phase 04 §E/§F)
  const [knowledgeList, setKnowledgeList] = useState<KnowledgeSourceItem[]>([]);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicePreviewStatus, setVoicePreviewStatus] = useState<string | null>(null);

  const [schedules, setSchedules] = useState(d.schedules ?? []);
  const [newCron, setNewCron] = useState("0 9 * * 1-5");
  const [newTz, setNewTz] = useState("UTC");
  const [newPrompt, setNewPrompt] = useState("");

  const [subagents, setSubagents] = useState<SubagentRef[]>(d.subagents ?? []);
  const [selectedSubagentId, setSelectedSubagentId] = useState("");
  const [subagentMode, setSubagentMode] = useState<"ask" | "auto">("auto");

  const [skills, setSkills] = useState(d.skills ?? []);
  const [selectedSkillId, setSelectedSkillId] = useState<string>(REGISTERED_SKILLS[0].id);

  const [knowledgeBindings, setKnowledgeBindings] = useState(d.knowledge ?? []);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState("");

  const [memoryEnabled, setMemoryEnabled] = useState(d.memory?.enabled ?? true);
  const [memoryScope, setMemoryScope] = useState<"org" | "agent" | "thread" | "room">(d.memory?.scope ?? "org");
  const [memoryRetentionDays, setMemoryRetentionDays] = useState<number | undefined>(d.memory?.retentionDays ?? 30);

  const [voiceEnabled, setVoiceEnabled] = useState(d.voice?.enabled ?? false);
  const [selectedVoiceId, setSelectedVoiceId] = useState(d.voice?.voiceId ?? "voice_rachel");

  const isSchedLimitReached = schedLimit >= 0 && schedules.length >= schedLimit;
  const voiceEntitled = typeof caps.voice_minutes === "number" ? caps.voice_minutes > 0 : false;

  useEffect(() => {
    void mox.api.listModels().then(setModels);
    void mox.api.listAgentVersions(summary.agentId).then(setVersions).catch(() => setVersions([]));
    void mox.api.listKnowledgeSources().then(setKnowledgeList).catch(() => setKnowledgeList([]));
    void mox.api.listVoices().then(setVoices).catch(() => setVoices([]));
  }, [mox.api, summary.agentId]);

  const log = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const saveDraft = async () => {
    setError(null);
    setBusy(true);
    try {
      const updatedDefinition = {
        ...summary.definition,
        identity: { ...summary.definition.identity, role: role.trim() || undefined },
        instructions: { text: instructions },
        computer: { ...summary.definition.computer, enabled: browser, allowBrowser: browser },
        voice: { enabled: voiceEnabled, voiceId: selectedVoiceId },
        schedules,
        subagents,
        skills,
        knowledge: knowledgeBindings,
        memory: {
          enabled: memoryEnabled,
          scope: memoryScope,
          ...(memoryRetentionDays ? { retentionDays: Number(memoryRetentionDays) } : {}),
        },
      };
      await mox.api.updateAgentDraft(summary.agentId, {
        mode: "developer",
        slug: summary.definition.slug,
        raw: updatedDefinition,
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

  const handleAddSchedule = () => {
    if (!newCron.trim() || !newPrompt.trim() || isSchedLimitReached) return;
    const schedId = `sched_${Date.now()}`;
    setSchedules([...schedules, { scheduleId: schedId, cron: newCron.trim(), timezone: newTz.trim() || "UTC", prompt: newPrompt.trim(), enabled: true }]);
    setNewPrompt("");
    setDirty(true);
  };

  const handleToggleSchedule = (id: string) => {
    setSchedules(schedules.map((s) => (s.scheduleId === id ? { ...s, enabled: !s.enabled } : s)));
    setDirty(true);
  };

  const handleRemoveSchedule = (id: string) => {
    setSchedules(schedules.filter((s) => s.scheduleId !== id));
    setDirty(true);
  };

  const handleAddSubagent = () => {
    if (!selectedSubagentId) return;
    if (selectedSubagentId === summary.agentId || selectedSubagentId === summary.definition.slug) {
      setError("An agent cannot delegate to itself as a subagent.");
      return;
    }
    if (subagents.some((s) => s.agentId === selectedSubagentId)) {
      setError("Subagent already configured.");
      return;
    }
    setSubagents([...subagents, { agentId: selectedSubagentId as AgentId, delegation: subagentMode }]);
    setSelectedSubagentId("");
    setDirty(true);
  };

  const handleRemoveSubagent = (agentId: string) => {
    setSubagents(subagents.filter((s) => s.agentId !== agentId));
    setDirty(true);
  };

  const handleAddSkill = () => {
    const s = selectedSkillId.trim();
    if (!s || skills.some((sk) => sk.skillId === s)) return;
    setSkills([...skills, { skillId: s }]);
    setDirty(true);
  };

  const handleRemoveSkill = (skillId: string) => {
    setSkills(skills.filter((s) => s.skillId !== skillId));
    setDirty(true);
  };

  const handleAddKnowledge = () => {
    if (!selectedKnowledgeId || knowledgeBindings.some((k) => k.knowledgeId === selectedKnowledgeId)) return;
    setKnowledgeBindings([...knowledgeBindings, { knowledgeId: selectedKnowledgeId as any, access: ["read", "search"] as const }]);
    setSelectedKnowledgeId("");
    setDirty(true);
  };

  const handleToggleKnowledgeAccess = (knowledgeId: string, perm: "read" | "search" | "attach") => {
    setKnowledgeBindings(
      knowledgeBindings.map((kb) => {
        if (kb.knowledgeId !== knowledgeId) return kb;
        const current = kb.access ?? ["read", "search"];
        const has = current.includes(perm);
        let next: ("read" | "search" | "attach")[];
        if (has) {
          if (current.length <= 1) return kb;
          next = current.filter((p) => p !== perm);
        } else {
          next = [...current, perm];
        }
        return { ...kb, access: next as [("read" | "search" | "attach"), ...("read" | "search" | "attach")[]] };
      }),
    );
    setDirty(true);
  };

  const handleRemoveKnowledge = (id: string) => {
    setKnowledgeBindings(knowledgeBindings.filter((k) => k.knowledgeId !== id));
    setDirty(true);
  };

  const handlePreviewVoice = async () => {
    if (!selectedVoiceId) return;
    setVoicePreviewStatus("Synthesizing preview sample…");
    try {
      const res = await mox.api.previewVoice(selectedVoiceId, "Hello! I am your Mox AI agent voice.");
      if (res.ok) {
        setVoicePreviewStatus("Preview verified (audio sample synthesized).");
      } else {
        setVoicePreviewStatus(res.reason ?? "Voice synthesis unavailable.");
      }
    } catch (e) {
      setVoicePreviewStatus(e instanceof Error ? e.message : String(e));
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

      {/* Phase 04 §E: Schedules */}
      <Card title="Schedules & Heartbeats (Cron Automations)">
        <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
          Configure recurrent triggers and periodic prompt executions for autonomous agent operation.
        </p>
        {schedules.length === 0 ? (
          <EmptyState>No schedules configured for this agent.</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {schedules.map((s) => (
              <div key={s.scheduleId} className="work-item" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={s.enabled !== false}
                        onChange={() => handleToggleSchedule(s.scheduleId)}
                        disabled={busy}
                      />
                      <Badge tone={s.enabled !== false ? "good" : "neutral"}>
                        {s.enabled !== false ? "Enabled" : "Disabled"}
                      </Badge>
                    </label>
                    <code className="mono">{s.cron}</code>
                    <Badge tone="accent">{s.timezone ?? "UTC"}</Badge>
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>Prompt: <em>{s.prompt}</em></div>
                </div>
                <Button size="sm" kind="danger" disabled={busy} onClick={() => handleRemoveSchedule(s.scheduleId)}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
        {isSchedLimitReached ? (
          <div className="notice" style={{ marginTop: 8, marginBottom: 8 }}>
            <Badge tone="warn">Limit Reached</Badge> Schedule limit reached on current plan ({schedules.length} of {schedLimit} allowed). Remove an existing schedule to add another.
          </div>
        ) : null}
        <div className="form-grid" style={{ marginTop: 10 }}>
          <label className="form-field">
            Cron expression
            <input value={newCron} placeholder="0 9 * * 1-5" onChange={(e) => setNewCron(e.target.value)} disabled={busy || isSchedLimitReached} />
          </label>
          <label className="form-field">
            Timezone
            <input value={newTz} placeholder="UTC" onChange={(e) => setNewTz(e.target.value)} disabled={busy || isSchedLimitReached} />
          </label>
          <label className="form-field form-field-wide">
            Execution prompt
            <input value={newPrompt} placeholder="Analyze daily metrics and produce report" onChange={(e) => setNewPrompt(e.target.value)} disabled={busy || isSchedLimitReached} />
          </label>
          <div className="row-actions" style={{ alignItems: "flex-end" }}>
            <Button
              size="sm"
              kind="primary"
              disabled={busy || !newPrompt.trim() || isSchedLimitReached}
              title={isSchedLimitReached ? "Schedule limit reached on current plan" : undefined}
              onClick={handleAddSchedule}
            >
              Add schedule
            </Button>
          </div>
        </div>
      </Card>

      {/* Phase 04 §E: Subagents */}
      <Card title="Subagent Delegation (Multi-Agent Workspace)">
        <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
          Delegate tasks to peer or subordinate agents within this workspace. Agents cannot self-reference.
        </p>
        {subagents.length === 0 ? (
          <EmptyState>No subagents configured.</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {subagents.map((sub) => {
              const targetAgent = mox.agents.find((a) => a.agentId === sub.agentId);
              return (
                <div key={sub.agentId} className="work-item" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <strong>{targetAgent?.definition.identity.displayName ?? sub.agentId}</strong>
                    <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>({sub.delegation ?? "hierarchical"})</span>
                  </div>
                  <Button size="sm" kind="danger" disabled={busy} onClick={() => handleRemoveSubagent(sub.agentId)}>
                    Remove
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <div className="form-grid" style={{ marginTop: 10 }}>
          <label className="form-field">
            Delegate to agent
            <select value={selectedSubagentId} onChange={(e) => setSelectedSubagentId(e.target.value)}>
              <option value="">Select workspace agent…</option>
              {mox.agents
                .filter((a) => a.agentId !== summary.agentId && a.definition.slug !== summary.definition.slug)
                .map((a) => (
                  <option key={a.agentId} value={a.agentId}>
                    {a.definition.identity.displayName} ({a.definition.identity.role ?? "agent"})
                  </option>
                ))}
            </select>
          </label>
          <label className="form-field">
            Delegation mode
            <select value={subagentMode} onChange={(e) => setSubagentMode(e.target.value as "ask" | "auto")}>
              <option value="auto">Auto (automatic task delegation)</option>
              <option value="ask">Ask (supervised / requires approval)</option>
            </select>
          </label>
          <div className="row-actions" style={{ alignItems: "flex-end" }}>
            <Button size="sm" kind="primary" disabled={busy || !selectedSubagentId} onClick={handleAddSubagent}>
              Add subagent
            </Button>
          </div>
        </div>
      </Card>

      {/* Phase 04 §E: Skills */}
      <Card title="Skills & Grounding Tools">
        <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
          Assign modular tool skills to expand agent domain problem-solving. Only curated, registered skills are available.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {skills.length === 0 ? <span className="muted">No skills assigned yet.</span> : null}
          {skills.map((sk) => {
            const def = REGISTERED_SKILLS.find((r) => r.id === sk.skillId);
            return (
              <span key={sk.skillId} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Badge tone="neutral">{def?.label ?? sk.skillId}</Badge>
                <button
                  type="button"
                  onClick={() => handleRemoveSkill(sk.skillId)}
                  disabled={busy}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11 }}
                  aria-label={`Remove ${sk.skillId}`}
                >
                  ✕
                </button>
              </span>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={selectedSkillId}
            onChange={(e) => setSelectedSkillId(e.target.value)}
            style={{ flex: 1 }}
            disabled={busy}
          >
            {REGISTERED_SKILLS.map((sk) => (
              <option key={sk.id} value={sk.id} disabled={skills.some((s) => s.skillId === sk.id)}>
                {sk.label} — {sk.description} {skills.some((s) => s.skillId === sk.id) ? "(assigned)" : ""}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={busy || skills.some((s) => s.skillId === selectedSkillId)} onClick={handleAddSkill}>
            Assign skill
          </Button>
        </div>
      </Card>

      {/* Phase 04 §E/§H: Knowledge sources */}
      <Card title="Knowledge Sources (RAG & Documents)">
        <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
          Ground agent context in organization knowledge repositories and documentation catalogs.
        </p>
        {knowledgeBindings.length === 0 ? (
          <EmptyState>No knowledge sources bound to this agent.</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {knowledgeBindings.map((kb) => {
              const src = knowledgeList.find((k) => k.id === kb.knowledgeId);
              return (
                <div key={kb.knowledgeId} className="work-item" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div>
                      <strong>{src?.name ?? kb.knowledgeId}</strong>
                      <span style={{ marginLeft: 8 }}><Badge tone="accent">{src?.kind ?? "documents"}</Badge></span>
                    </div>
                    <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 6, fontSize: 12 }}>
                      <span className="muted">Access:</span>
                      {(["read", "search", "attach"] as const).map((perm) => (
                        <label key={perm} style={{ display: "inline-flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={kb.access?.includes(perm) ?? (perm !== "attach")}
                            onChange={() => handleToggleKnowledgeAccess(kb.knowledgeId, perm)}
                            disabled={busy}
                          />
                          {perm}
                        </label>
                      ))}
                    </div>
                  </div>
                  <Button size="sm" kind="danger" disabled={busy} onClick={() => handleRemoveKnowledge(kb.knowledgeId)}>
                    Unbind
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {knowledgeList.length === 0 ? (
          <div className="notice" style={{ marginTop: 10, fontSize: 12.5 }}>
            No organization knowledge sources registered yet. You can create document and data repositories in <Link to="/settings#knowledge">Settings → Knowledge Sources & Storage</Link>.
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <select
              value={selectedKnowledgeId}
              onChange={(e) => setSelectedKnowledgeId(e.target.value)}
              style={{ flex: 1 }}
              disabled={busy}
            >
              <option value="">Select organization knowledge source…</option>
              {knowledgeList
                .filter((k) => !knowledgeBindings.some((kb) => kb.knowledgeId === k.id))
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.kind})
                  </option>
                ))}
            </select>
            <Button size="sm" kind="primary" disabled={busy || !selectedKnowledgeId} onClick={handleAddKnowledge}>
              Bind source
            </Button>
          </div>
        )}
      </Card>

      {/* Phase 04 §E: Memory */}
      <Card title="Memory & Cross-Session Recall">
        <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
          Control memory isolation and contextual persistence across conversation turns.
        </p>
        <div className="notice" style={{ borderLeft: "3px solid var(--warn, #e6a23c)", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Badge tone="warn">Configuration Stored Only</Badge>
            <strong>Runtime Memory Engine Inactive</strong>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Memory scope and retention policies are validated and persisted in the canonical AgentDefinition, but persistent cross-session memory recall is not yet consumed by the active runtime engine.
          </p>
        </div>
        <div className="form-grid">
          <label className="form-field form-field-wide" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={memoryEnabled}
              onChange={(e) => { setMemoryEnabled(e.target.checked); setDirty(true); }}
            />
            Enable persistent memory recall
          </label>
          <label className="form-field">
            Memory scope
            <select
              value={memoryScope}
              disabled={!memoryEnabled}
              onChange={(e) => { setMemoryScope(e.target.value as "org" | "agent" | "thread" | "room"); setDirty(true); }}
            >
              <option value="org">Organization scope (shared across agents in org)</option>
              <option value="agent">Agent scope (isolated to this agent)</option>
              <option value="thread">Thread scope (isolated to single thread)</option>
              <option value="room">Room scope (shared in multi-agent room)</option>
            </select>
          </label>
          <label className="form-field">
            Retention period (days)
            <input
              type="number"
              min={1}
              max={365}
              value={memoryRetentionDays ?? ""}
              placeholder="30"
              disabled={!memoryEnabled}
              onChange={(e) => {
                const val = e.target.value ? parseInt(e.target.value, 10) : undefined;
                setMemoryRetentionDays(val);
                setDirty(true);
              }}
            />
          </label>
        </div>
      </Card>

      {/* Phase 04 §F: Voice */}
      <Card title="Voice Synthesis (ElevenLabs Integration)">
        <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
          Enable speech synthesis for spoken responses and conversational room participation.
        </p>
        {!voiceEntitled ? (
          <div className="notice" style={{ marginBottom: 12 }}>
            <Badge tone="warn">Not Entitled</Badge> Voice synthesis is not included in your current plan entitlement (voice minutes quota is 0).
          </div>
        ) : null}
        <div className="form-grid">
          <label className="form-field form-field-wide" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={voiceEnabled}
              onChange={(e) => { setVoiceEnabled(e.target.checked); setDirty(true); }}
            />
            Enable voice synthesis
          </label>
          <label className="form-field">
            Voice personality
            <select
              value={selectedVoiceId}
              disabled={!voiceEnabled}
              onChange={(e) => { setSelectedVoiceId(e.target.value); setDirty(true); }}
            >
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.description ?? v.provider}
                </option>
              ))}
            </select>
          </label>
          <div className="row-actions" style={{ alignItems: "flex-end" }}>
            <Button
              size="sm"
              disabled={busy || !voiceEnabled || !voiceEntitled}
              title={!voiceEntitled ? "Voice synthesis not entitled on current plan" : undefined}
              onClick={() => void handlePreviewVoice()}
            >
              Synthesize audio sample
            </Button>
          </div>
        </div>
        {voicePreviewStatus ? <div className="notice" style={{ marginTop: 10 }}>{voicePreviewStatus}</div> : null}
      </Card>

      {/* Phase 04 §E: Honest Unavailable Workflows Card */}
      <Card title="Workflow Automation Engine">
        <FeatureUnavailable
          label="Workflow Automations"
          reason="The active runtime does not compose a workflow execution engine (code: not_configured). Directed multi-step workflow graphs require an external engine gateway."
        />
      </Card>

      {/* Phase 04 §E: Honest NOT_PRODUCTIZED_BLOCKED Local Device Card */}
      <Card title="Deployment Target: Local Device">
        <div className="notice" style={{ borderLeft: "3px solid var(--accent-bad)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Badge tone="bad">NOT_PRODUCTIZED_BLOCKED</Badge>
            <strong>Local device deployment blocked</strong>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Execution on local physical devices is blocked because no local device relay daemon is composed on this customer deployment. Deployments are restricted to Cloud Sandbox, Mox Cloud, or Customer VPS.
          </p>
        </div>
      </Card>

      {dirty ? (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 0" }}>
          <Button kind="primary" disabled={busy} onClick={() => void saveDraft()}>
            {busy ? "Saving draft…" : "Save draft changes"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}







