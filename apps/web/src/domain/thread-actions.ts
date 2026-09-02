import type { MoxApi } from "../api/types.js";

/**
 * Thread management actions that must stay testable and go through the
 * canonical API seam only (archive is server-authoritative; there is no
 * client-side thread state mutation and no invented restore).
 */

export interface ArchiveConversationDeps {
  archiveThread: MoxApi["archiveThread"];
  /** Refreshes the Recent rail (the server excludes archived from "recent"). */
  syncThreads?: () => Promise<void>;
  /** Selection fallback after a successful archive. */
  onArchived: (threadId: string) => void;
  onError: (message: string) => void;
}

/**
 * Archives the conversation and falls back to the agent's start state.
 * On failure nothing is selected away — the user keeps their thread and a
 * concise error is surfaced.
 */
export async function archiveCurrentConversation(
  deps: ArchiveConversationDeps,
  threadId: string,
): Promise<void> {
  try {
    await deps.archiveThread(threadId);
    deps.onArchived(threadId);
    await deps.syncThreads?.().catch(() => undefined);
  } catch (error) {
    deps.onError(error instanceof Error ? error.message : String(error));
  }
}
