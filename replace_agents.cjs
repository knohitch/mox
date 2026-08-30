const fs = require('fs');
const content = fs.readFileSync('apps/web/src/views/AgentsView.tsx', 'utf8');

const newAgentsView = `export function AgentsView() {
  const mox = useMox();
  const entitlements = useEntitlements();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState("");
  const selected = useMemo(
    () => mox.agents.find((a) => a.agentId === selectedId) ?? null,
    [mox.agents, selectedId],
  );

  const maxAgents = limitOf(entitlements, "max_agents", Infinity);
  const atAgentLimit = maxAgents > 0 && mox.agents.length >= maxAgents;

  const filteredAgents = useMemo(() => {
    if (!search) return mox.agents;
    const lower = search.toLowerCase();
    return mox.agents.filter((a) => a.definition.identity.displayName.toLowerCase().includes(lower) || a.definition.slug.toLowerCase().includes(lower));
  }, [mox.agents, search]);

  const gradients = [
    "linear-gradient(135deg, #3b82f6, #8b5cf6)",
    "linear-gradient(135deg, #f59e0b, #ef4444)",
    "linear-gradient(135deg, #10b981, #3b82f6)",
    "linear-gradient(135deg, #ec4899, #8b5cf6)",
    "linear-gradient(135deg, #06b6d4, #3b82f6)",
  ];

  return (
    <div className="agents-workspace">
      {/* Left Rail */}
      <div className="aw-sidebar">
        <div className="aw-sidebar-header">
          <div className="aw-sidebar-title">Mox Agents</div>
          <button className="aw-sidebar-new" onClick={() => setShowNew(true)} title="New Agent" disabled={atAgentLimit}>
            +
          </button>
        </div>
        <div className="aw-search-box">
          <input
            type="text"
            className="aw-search-input"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="aw-sidebar-list">
          {filteredAgents.map((a, i) => (
            <div
              key={a.agentId}
              className={\`aw-agent-row \${a.agentId === selectedId ? "active" : ""}\`}
              onClick={() => setSelectedId(a.agentId)}
              role="button"
              tabIndex={0}
            >
              <div className="aw-agent-row-icon" style={{ background: gradients[i % gradients.length] }}>
                {a.definition.identity.displayName[0]?.toUpperCase()}
              </div>
              <div className="aw-agent-row-content">
                <div className="aw-agent-row-title">{a.definition.identity.displayName}</div>
                <div className="aw-agent-row-sub">{a.status === "draft" ? "Unpublished draft" : (a.definition.identity.title ?? a.definition.identity.role ?? "Mox Assistant")}</div>
              </div>
            </div>
          ))}
          {filteredAgents.length === 0 && (
            <div className="muted" style={{ padding: "20px", textAlign: "center", fontSize: 13 }}>
              No agents found.
            </div>
          )}
        </div>
        <div className="aw-sidebar-footer">
          <Link to="/settings#agents" className="aw-sidebar-footer-item">
            <span aria-hidden>⚙️</span> Settings
          </Link>
          <a href="#" className="aw-sidebar-footer-item" onClick={(e) => { e.preventDefault(); setSelectedId(null); }}>
            <span aria-hidden>🤖</span> Agents Hub
          </a>
        </div>
      </div>

      {/* Main Area */}
      <div className="aw-main">
        {selected ? (
          <AgentDetail summary={selected} />
        ) : (
          <div className="aw-hub">
            <div className="aw-hub-title">Mox Workspace</div>
            <div className="aw-hub-heading">Start a new conversation</div>
            
            <div className="aw-composer-wrapper">
              <textarea
                className="aw-composer"
                placeholder="Choose an agent below to start..."
                disabled
              />
              <button className="aw-composer-submit" disabled>×</button>
              <div className="aw-composer-hint">All conversations are secure and isolated within the Mox runtime.</div>
            </div>

            {mox.agents.length > 0 ? (
              <>
                <div className="aw-explore-heading">Explore agents</div>
                <div className="aw-agent-grid">
                  {mox.agents.map((a, i) => (
                    <div
                      key={a.agentId}
                      className="aw-agent-card"
                      onClick={() => setSelectedId(a.agentId)}
                    >
                      <div className="aw-agent-card-title">{a.definition.identity.displayName}</div>
                      <div className="aw-agent-card-desc">{a.definition.instructions.text || "No instructions provided."}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", color: "#94a3b8" }}>
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
}`;

let newContent = content.replace(/export function AgentsView\(\) \{[\s\S]*?(?=\/\/ ---)/, newAgentsView + '\n\n');
newContent = newContent.replace(/function AgentRow\(\{[\s\S]*?(?=\nconst TABS)/, '');

fs.writeFileSync('apps/web/src/views/AgentsView.tsx', newContent);
