import { useEffect, useState, useMemo } from "react";
import { useRoute } from "../router.js";
import { Modal } from "./primitives.js";

interface Command {
  id: string;
  label: string;
  icon?: string;
  action: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { navigate } = useRoute();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const commands: Command[] = useMemo(() => [
    { id: "home", label: "Go to Home", icon: "⌂", action: () => navigate("/") },
    { id: "agents", label: "Manage Agents", icon: "🤖", action: () => navigate("/agents") },
    { id: "deployments", label: "Deployments", icon: "☁️", action: () => navigate("/deployments") },
    { id: "settings", label: "Settings", icon: "⚙️", action: () => navigate("/settings") },
    { id: "admin", label: "Admin Console", icon: "🛡️", action: () => navigate("/admin") },
  ], [navigate]);

  const filtered = query === "" 
    ? commands 
    : commands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()));

  if (!open) return null;

  return (
    <div className="cmd-backdrop" onClick={() => setOpen(false)}>
      <div className="cmd-palette" onClick={e => e.stopPropagation()}>
        <input 
          autoFocus 
          placeholder="Type a command or search..." 
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="cmd-input"
        />
        <div className="cmd-list">
          {filtered.map(cmd => (
            <button 
              key={cmd.id} 
              className="cmd-item"
              onClick={() => {
                cmd.action();
                setOpen(false);
              }}
            >
              {cmd.icon && <span className="cmd-icon">{cmd.icon}</span>}
              {cmd.label}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="cmd-empty">No results found.</div>
          )}
        </div>
      </div>
    </div>
  );
}
