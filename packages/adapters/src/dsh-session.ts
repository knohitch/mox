import type { AgentEvent, SessionEvent } from "@mox/contracts";

/**
 * DSH session persistence adapter (Prompt 06).
 *
 * The kernel never owns durable history. After a restart it reconstructs its
 * working context from Mox-owned storage via this adapter:
 * - `rebuildHistory` folds stored events into the message list the model seam
 *   consumes (user turns + final assistant texts + tool summaries);
 * - `dedupeById` makes replay idempotent after reconnect/retry;
 * - resume tokens stay opaque strings minted by the runtime.
 */

export interface DshHistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Tool name when role === "tool". */
  toolName?: string;
}

export function dedupeById<T extends { eventId?: string; type: string }>(events: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of events) {
    const key = e.eventId ?? `${e.type}:${out.length}`;
    if (typeof e.eventId === "string") {
      if (seen.has(e.eventId)) continue;
      seen.add(e.eventId);
    }
    void key;
    out.push(e);
  }
  return out;
}

/** Fold canonical AgentEvents (live stream shape) into DSH history. */
export function rebuildHistoryFromAgentEvents(events: readonly AgentEvent[]): DshHistoryMessage[] {
  const clean = dedupeById(events);
  const history: DshHistoryMessage[] = [];
  for (const e of clean) {
    switch (e.type) {
      case "message.completed":
        history.push({ role: "assistant", content: e.text });
        break;
      case "tool.completed":
        history.push({
          role: "tool",
          content: summarize(e.output),
          toolName: e.toolName,
        });
        break;
      default:
        // deltas, approvals and lifecycle events are not conversation turns
        break;
    }
  }
  return history;
}

/** Fold durable SessionEvents into the same history shape. */
export function rebuildHistory(events: readonly SessionEvent[]): DshHistoryMessage[] {
  const clean = dedupeById(events);
  const history: DshHistoryMessage[] = [];
  for (const e of clean) {
    switch (e.type) {
      case "user.message":
        history.push({ role: "user", content: e.text });
        break;
      case "assistant.final":
        history.push({ role: "assistant", content: e.text });
        break;
      case "tool.completed":
        history.push({ role: "tool", content: summarize(e.outputSummary), toolName: e.toolName });
        break;
      default:
        break;
    }
  }
  return history;
}

function summarize(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

/** Opaque resume token binding a run to its last persisted sequence. */
export function toResumeToken(input: { runId: string; lastSeq: number }): string {
  return Buffer.from(JSON.stringify({ runId: input.runId, lastSeq: input.lastSeq }), "utf8").toString("base64url");
}

export function fromResumeToken(token: string): { runId: string; lastSeq: number } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      runId?: unknown;
      lastSeq?: unknown;
    };
    if (typeof parsed.runId !== "string" || typeof parsed.lastSeq !== "number") return undefined;
    return { runId: parsed.runId, lastSeq: parsed.lastSeq };
  } catch {
    return undefined;
  }
}
