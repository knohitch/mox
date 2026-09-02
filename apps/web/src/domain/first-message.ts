import type { MoxApi } from "../api/types.js";

/**
 * One canonical first-message flow (Quick Start Composer repair): every
 * surface that starts a brand-new conversation — the Agents Hub composer, an
 * agent's empty-thread composer, suggested prompts — goes through
 * `startConversation`. It creates the durable thread through the canonical
 * API seam only when the user actually sends, selects it immediately (so the
 * UI transitions into the active conversation view), then submits the first
 * message through the store's normal send pipeline (optimistic bubble,
 * streaming events, approvals). No parallel chat path, no invented thread ids,
 * no silent default agent.
 */

export const FALLBACK_THREAD_TITLE = "New conversation";

/** Threads show a derived title in Recent; keep it short and deterministic. */
const MAX_TITLE_LENGTH = 48;

/**
 * Deterministic local title derivation — whitespace-collapsed first line,
 * clamped on a word boundary. No external AI call, no per-user randomness.
 */
export function deriveSafeTitle(initialMessage: string): string {
  const cleaned = initialMessage.replace(/\s+/g, " ").trim();
  if (!cleaned) return FALLBACK_THREAD_TITLE;
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned;
  const cut = cleaned.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > MAX_TITLE_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

export interface StartConversationDeps {
  createThread: MoxApi["createThread"];
  loadThread: (agentId: string, threadId: string) => Promise<void>;
  send: (agentId: string, threadId: string, text: string) => Promise<void>;
  /** Called once the durable thread exists — selects it in the UI. */
  onThreadReady: (agentId: string, threadId: string) => void;
  /** Refreshes the Recent rail after the flow settles. */
  syncThreads?: () => Promise<void>;
  /** Concise, safe error surface for the calling view. */
  onError?: (message: string) => void;
}

/**
 * Lifecycle: the thread is created only when the first message is actually
 * sent — never merely on agent selection. If creation succeeds but the send
 * fails, the created thread stays selected and retries happen inside it, so a
 * retry never mints a duplicate thread.
 */
export async function startConversation(
  deps: StartConversationDeps,
  input: { agentId: string; initialMessage: string },
): Promise<void> {
  const text = input.initialMessage.trim();
  if (!text) return;

  let threadId: string | null = null;
  try {
    const thread = await deps.createThread({
      agentId: input.agentId,
      title: deriveSafeTitle(text),
    });
    threadId = thread.threadId;
    deps.onThreadReady(input.agentId, thread.threadId);
    await deps.loadThread(input.agentId, thread.threadId);
  } catch (error) {
    deps.onError?.(error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    await deps.send(input.agentId, threadId, text);
  } catch (error) {
    deps.onError?.(error instanceof Error ? error.message : String(error));
  } finally {
    await deps.syncThreads?.().catch(() => undefined);
  }
}

/** No-op free: deterministic starter prompts for an agent's empty thread. */
export const EMPTY_THREAD_SUGGESTIONS: readonly string[] = [
  "Research a market",
  "Analyze a document",
  "Compare competitors",
  "Build a research brief",
];
