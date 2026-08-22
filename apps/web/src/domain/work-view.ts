import type { AgentEvent } from "@mox/contracts";

/**
 * Work view (Prompt 05): a Codex/Claude-Code-style activity surface projected
 * from CANONICAL runtime events. Private chain-of-thought never exists in the
 * event store, so nothing here can leak it — only explicit model/runtime
 * activity summaries and tool events are rendered.
 */

export type WorkItemKind =
  | "turn"
  | "message"
  | "tool"
  | "terminal"
  | "file-change"
  | "approval"
  | "error";

export interface WorkViewItem {
  kind: WorkItemKind;
  /** Stable ordering key (event id). */
  eventId: string;
  at: string;
  turnId?: string;
  title: string;
  detail?: string;
  ok?: boolean;
}

const TERMINAL_TOOLS = new Set(["shell", "execute", "terminal", "computer"]);

function isFileTool(toolName: string): boolean {
  return /file|diff|patch|workspace/i.test(toolName);
}

/** Fold a canonical event stream into ordered, human-readable work items. */
export function projectWorkView(events: readonly AgentEvent[]): WorkViewItem[] {
  const items: WorkViewItem[] = [];
  const openTools = new Map<string, { name: string; input: unknown }>();

  for (const e of events) {
    switch (e.type) {
      case "turn.started":
        items.push({
          kind: "turn",
          eventId: e.eventId,
          at: e.at,
          turnId: e.turnId,
          title: "Turn started",
          detail: summarize(e.input),
        });
        break;
      case "turn.completed":
        items.push({
          kind: "turn",
          eventId: e.eventId,
          at: e.at,
          turnId: e.turnId,
          title: "Turn completed",
          detail: summarize(e.output),
          ok: true,
        });
        break;
      case "turn.failed":
        items.push({
          kind: "error",
          eventId: e.eventId,
          at: e.at,
          turnId: e.turnId,
          title: "Turn failed",
          detail: e.error,
          ok: false,
        });
        break;
      case "message.delta":
        break; // streaming deltas are chat-surface concern, not work items
      case "message.completed":
        items.push({
          kind: "message",
          eventId: e.eventId,
          at: e.at,
          turnId: e.turnId,
          title: "Assistant message",
          detail: firstLine(e.text),
        });
        break;
      case "tool.requested":
        openTools.set(keyOf(e), { name: e.toolName, input: e.input });
        if (!TERMINAL_TOOLS.has(e.toolName) && !isFileTool(e.toolName)) {
          items.push({
            kind: "tool",
            eventId: e.eventId,
            at: e.at,
            turnId: e.turnId,
            title: `Tool ${e.toolName}`,
            detail: summarize(e.input),
          });
        }
        if (TERMINAL_TOOLS.has(e.toolName)) {
          items.push({
            kind: "terminal",
            eventId: e.eventId,
            at: e.at,
            turnId: e.turnId,
            title: `Terminal · ${e.toolName}`,
            detail: commandOf(e.input),
          });
        }
        if (isFileTool(e.toolName)) {
          items.push({
            kind: "file-change",
            eventId: e.eventId,
            at: e.at,
            turnId: e.turnId,
            title: `Files · ${e.toolName}`,
            detail: summarize(e.input),
          });
        }
        break;
      case "tool.completed": {
        // Attach the outcome to the most recent matching item.
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const item = items[i] as WorkViewItem;
          if (
            (item.kind === "tool" || item.kind === "terminal" || item.kind === "file-change") &&
            item.title.endsWith(e.toolName)
          ) {
            item.ok = e.ok;
            if (!e.ok && typeof e.output === "object" && e.output !== null) {
              const err = (e.output as { error?: unknown }).error;
              if (typeof err === "string") item.detail = `${item.detail ?? ""} → ${err}`.trim();
            }
            break;
          }
        }
        void openTools;
        break;
      }
      case "approval.opened":
        items.push({
          kind: "approval",
          eventId: e.eventId,
          at: e.at,
          turnId: e.turnId,
          title: `Approval requested`,
          detail: e.summary,
        });
        break;
      case "approval.resolved":
        items.push({
          kind: "approval",
          eventId: e.eventId,
          at: e.at,
          turnId: e.turnId,
          title: `Approval ${e.outcome}`,
          ok: e.outcome === "approved",
        });
        break;
      case "error":
        items.push({
          kind: "error",
          eventId: e.eventId,
          at: e.at,
          turnId: e.turnId,
          title: e.fatal ? "Fatal error" : "Recoverable error",
          detail: e.error,
          ok: false,
        });
        break;
    }
  }
  return items;
}

function keyOf(e: Extract<AgentEvent, { type: "tool.requested" }>): string {
  return `${e.turnId ?? "-"}:${e.toolName}:${stableInput(e.input)}`;
}

function stableInput(input: unknown): string {
  try {
    return JSON.stringify(input)?.slice(0, 80) ?? "";
  } catch {
    return "";
  }
}

function summarize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function commandOf(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null) {
    const cmd = (input as { command?: unknown }).command;
    if (typeof cmd === "string") return cmd.slice(0, 160);
    const action = (input as { action?: { command?: unknown } }).action;
    if (action && typeof action.command === "string") return action.command.slice(0, 160);
  }
  return summarize(input);
}
