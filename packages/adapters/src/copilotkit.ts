import type { AgentEvent, SessionEvent } from "@mox/contracts";

/**
 * CopilotKit / AG-UI compatibility adapter (Prompt 06).
 *
 * CopilotKit MAY remain useful as a client transport layer; it must never be
 * the authoritative persistence store. This adapter projects canonical Mox
 * events INTO the message shapes AG-UI clients understand. Nothing here
 * writes to storage — authority stays with the Mox event store.
 */

export interface AgUiMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** Tool name for role "tool". */
  name?: string;
}

export function agentEventsToCopilotMessages(events: readonly AgentEvent[]): AgUiMessage[] {
  const out: AgUiMessage[] = [];
  for (const e of dedupe(events)) {
    switch (e.type) {
      case "message.completed":
        out.push({ id: e.messageId, role: "assistant", content: e.text });
        break;
      case "tool.completed":
        out.push({ id: `${e.eventId}`, role: "tool", name: e.toolName, content: JSON.stringify(e.output) });
        break;
      case "turn.started":
        // AG-UI has no turn concept; surfaced as system context only.
        break;
      default:
        break;
    }
  }
  return out;
}

export function sessionEventsToCopilotMessages(events: readonly SessionEvent[]): AgUiMessage[] {
  const out: AgUiMessage[] = [];
  for (const e of dedupe(events)) {
    switch (e.type) {
      case "user.message":
        out.push({ id: e.messageId, role: "user", content: e.text });
        break;
      case "assistant.final":
        out.push({ id: e.messageId, role: "assistant", content: e.text });
        break;
      case "tool.completed":
        out.push({ id: e.eventId, role: "tool", name: e.toolName, content: JSON.stringify(e.outputSummary) });
        break;
      default:
        break;
    }
  }
  return out;
}

function dedupe<T extends { eventId?: string }>(events: readonly T[]): T[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (typeof e.eventId !== "string") return true;
    if (seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    return true;
  });
}
