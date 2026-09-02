import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { AgentsView, AgentDetail } from "../src/views/AgentsView.js";
import {
  EMPTY_THREAD_SUGGESTIONS,
  FALLBACK_THREAD_TITLE,
  deriveSafeTitle,
  startConversation,
} from "../src/domain/first-message.js";
import { archiveCurrentConversation } from "../src/domain/thread-actions.js";
import type { AgentSummary, ChatMessage } from "../src/api/types.js";

/**
 * Quick Start Composer repair tests (Prompt 01).
 *
 * The vitest environment is plain node (no jsdom), matching the repo's
 * renderToString test convention: logic is exercised directly through
 * `startConversation`/`deriveSafeTitle`, and UI states are asserted from
 * server-rendered markup.
 */

const mockApi = {
  listThreads: vi.fn(async () => [{ threadId: "t1", title: "Test thread", status: "active" }]),
  createThread: vi.fn(async () => ({ threadId: "th_unused", title: "unused" })),
  archiveThread: vi.fn(async () => ({ threadId: "t1", status: "archived" })),
  listModels: vi.fn(async () => []),
  listAgentVersions: vi.fn(async () => []),
  listKnowledgeSources: vi.fn(async () => []),
  listVoices: vi.fn(async () => []),
};

const storeSend = vi.fn(async () => {});
const storeLoadThread = vi.fn(async () => {});
const storeMessages = vi.fn((_threadId: string): ChatMessage[] => []);

let currentAgents: AgentSummary[] = [];
let currentReady = true;
let currentError: string | null = null;

vi.mock("../src/api/store.js", () => ({
  useMox: () => ({
    ready: currentReady,
    error: currentError,
    needsAuth: false,
    me: { displayName: "Test", email: "test@test.com", orgs: [] },
    agents: currentAgents,
    api: mockApi,
    send: storeSend,
    loadThread: storeLoadThread,
    messages: storeMessages,
    activeRun: () => null,
    approvals: [],
    eventsVersion: 0,
  }),
  useEntitlements: () => ({}),
  useTerminal: () => false,
  useBrowser: () => false,
  useDeveloperMode: () => false,
}));

function fixtureAgent(id: string, name: string): AgentSummary {
  return {
    agentId: id,
    status: "active",
    definition: {
      slug: `agent_${id}`,
      identity: { displayName: name },
      instructions: { text: "Test instructions" },
      computer: { enabled: false },
    },
  } as unknown as AgentSummary;
}

beforeEach(() => {
  currentAgents = [fixtureAgent("a1", "Research Agent"), fixtureAgent("a2", "Ops Agent")];
  currentReady = true;
  currentError = null;
  vi.clearAllMocks();
  storeMessages.mockImplementation((_threadId: string): ChatMessage[] => []);
});

describe("deriveSafeTitle (deterministic local thread titles)", () => {
  it("uses the trimmed first message as title", () => {
    expect(deriveSafeTitle("  Analyze the Q3 pipeline data  ")).toBe("Analyze the Q3 pipeline data");
  });

  it("collapses whitespace and newlines", () => {
    expect(deriveSafeTitle("line one\n\nline\ttwo")).toBe("line one line two");
  });

  it("clamps long messages on a word boundary", () => {
    const title = deriveSafeTitle("please help me understand exactly how the quarterly revenue reconciliation process works end to end");
    expect(title.length).toBeLessThanOrEqual(49); // 48 chars + ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("please help me")).toBe(true);
  });

  it("falls back for empty input", () => {
    expect(deriveSafeTitle("   ")).toBe(FALLBACK_THREAD_TITLE);
  });

  it("is deterministic", () => {
    expect(deriveSafeTitle("Research a market")).toBe(deriveSafeTitle("Research a market"));
  });
});

describe("startConversation (shared first-message flow)", () => {
  it("creates the thread exactly once and sends through the canonical seam", async () => {
    const deps = {
      createThread: vi.fn(async (input: { agentId: string; title?: string }) => ({ threadId: "th_9", title: input.title })),
      loadThread: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      onThreadReady: vi.fn(),
      syncThreads: vi.fn(async () => {}),
      onError: vi.fn(),
    };

    await startConversation(deps, { agentId: "a1", initialMessage: "  Hello world  " });

    expect(deps.createThread).toHaveBeenCalledTimes(1);
    expect(deps.createThread).toHaveBeenCalledWith({ agentId: "a1", title: "Hello world" });
    // The authoritative server threadId is used everywhere — never an invented one.
    expect(deps.onThreadReady).toHaveBeenCalledTimes(1);
    expect(deps.onThreadReady).toHaveBeenCalledWith("a1", "th_9");
    expect(deps.loadThread).toHaveBeenCalledWith("a1", "th_9");
    expect(deps.send).toHaveBeenCalledWith("a1", "th_9", "Hello world");
    expect(deps.syncThreads).toHaveBeenCalledTimes(1);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("never creates the thread when the message is empty", async () => {
    const deps = {
      createThread: vi.fn(),
      loadThread: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      onThreadReady: vi.fn(),
      syncThreads: vi.fn(async () => {}),
      onError: vi.fn(),
    };

    await startConversation(deps, { agentId: "a1", initialMessage: "   " });

    expect(deps.createThread).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.onThreadReady).not.toHaveBeenCalled();
  });

  it("preserves the draft state on thread-creation failure and does not send", async () => {
    const deps = {
      createThread: vi.fn(async () => {
        throw new Error("Thread service unavailable");
      }),
      loadThread: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      onThreadReady: vi.fn(),
      syncThreads: vi.fn(async () => {}),
      onError: vi.fn(),
    };

    await startConversation(deps, { agentId: "a1", initialMessage: "Hello" });

    expect(deps.createThread).toHaveBeenCalledTimes(1);
    expect(deps.onThreadReady).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith("Thread service unavailable");
  });

  it("keeps the created thread selected on send failure (no duplicate thread on retry)", async () => {
    const deps = {
      createThread: vi.fn(async () => ({ threadId: "th_9", title: "Hello" })),
      loadThread: vi.fn(async () => {}),
      send: vi.fn(async () => {
        throw new Error("Turn failed to start");
      }),
      onThreadReady: vi.fn(),
      syncThreads: vi.fn(async () => {}),
      onError: vi.fn(),
    };

    await startConversation(deps, { agentId: "a1", initialMessage: "Hello" });

    // Thread created exactly once and stays selected for in-thread retry.
    expect(deps.createThread).toHaveBeenCalledTimes(1);
    expect(deps.onThreadReady).toHaveBeenCalledTimes(1);
    expect(deps.onThreadReady).toHaveBeenCalledWith("a1", "th_9");
    expect(deps.onError).toHaveBeenCalledWith("Turn failed to start");
    // Recent still refreshes so the durable thread appears.
    expect(deps.syncThreads).toHaveBeenCalledTimes(1);
  });
});

describe("Agents Hub (server-rendered)", () => {
  it("renders an editable Quick Start composer with an agent picker", () => {
    const html = renderToString(<AgentsView />);
    expect(html).toContain("Start a new conversation");
    // Textarea is no longer hard-disabled and carries a label.
    expect(html).toContain('aria-label="Ask anything"');
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
    // Real agent picker fed by workspace agents (no silent default selected).
    expect(html).toContain('aria-label="Choose agent"');
    expect(html).toContain("Research Agent");
    expect(html).toContain("Ops Agent");
    expect(html).toContain("Choose agent");
  });

  it("disables Send while the draft is empty", () => {
    const html = renderToString(<AgentsView />);
    expect(html).toMatch(/class="aw-composer-submit"[^>]*disabled/);
    expect(html).toContain('aria-label="Send message"');
  });

  it("exposes agent cards as real selectable buttons", () => {
    const html = renderToString(<AgentsView />);
    expect(html).toContain('role="button"');
    expect(html).toContain("Open Research Agent");
  });

  it("differentiates New conversation (rail plus) from Create Agent", () => {
    const html = renderToString(<AgentsView />);
    // Rail header plus means "new conversation" — never agent creation.
    expect(html).toContain('aria-label="New conversation"');
    expect(html).toMatch(/class="aw-sidebar-new"[^>]*aria-label="New conversation"/);
    // Create Agent remains a separate explicit action in the workspace footer.
    expect(html).toContain("Create Agent");
  });
});

describe("Agents Hub — zero agents", () => {
  it("disables the composer and offers explicit agent creation only", () => {
    currentAgents = [];
    const html = renderToString(<AgentsView />);
    expect(html).toContain("Create your first Agent to start a conversation.");
    expect(html).toContain("Create Agent");
    // Composer disabled ONLY in this state.
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).not.toContain("aw-explore-section");
  });
});

describe("Agent empty-thread composer", () => {
  const noop = async () => {};

  it("renders working suggestions (no no-op buttons) and a functional composer", () => {
    const html = renderToString(
      <AgentDetail
        summary={fixtureAgent("a1", "Research Agent")}
        threadId={null}
        onThreadChange={noop}
        onNewChat={noop}
        onStartFirstMessage={noop}
      />,
    );
    for (const suggestion of EMPTY_THREAD_SUGGESTIONS) {
      expect(html).toContain(suggestion);
      expect(html).toContain(`Use suggestion: ${suggestion}`);
    }
    expect(html).not.toContain("void 0");
    expect(html).toContain('aria-label="Message Research Agent"');
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(/class="aw-composer-submit"[^>]*disabled/);
  });

  it("renders an existing conversation without a blank chat", () => {
    storeMessages.mockImplementation((threadId: string) =>
      threadId === "t1"
        ? [
            { messageId: "m1", threadId: "t1", authorId: "u_you", role: "user", text: "Summarize the pipeline.", at: new Date().toISOString() },
            { messageId: "m2", threadId: "t1", authorId: "a1", role: "agent", text: "Here is the summary.", at: new Date().toISOString() },
          ]
        : [],
    );
    const html = renderToString(
      <AgentDetail
        summary={fixtureAgent("a1", "Research Agent")}
        threadId="t1"
        onThreadChange={noop}
        onNewChat={noop}
        onStartFirstMessage={noop}
      />,
    );
    expect(html).toContain("Summarize the pipeline.");
    expect(html).toContain("Here is the summary.");
    expect(html).toContain("Message Research Agent");
  });
});

describe("startConversation call ordering", () => {
  it("runs create → select → load → send → sync in canonical order", async () => {
    const calls: string[] = [];
    const deps = {
      createThread: vi.fn(async () => { calls.push("create"); return { threadId: "th_9", title: "Hello" }; }),
      onThreadReady: vi.fn(() => { calls.push("ready"); }),
      loadThread: vi.fn(async () => { calls.push("load"); }),
      send: vi.fn(async () => { calls.push("send"); }),
      syncThreads: vi.fn(async () => { calls.push("sync"); }),
      onError: vi.fn(),
    };

    await startConversation(deps, { agentId: "a1", initialMessage: "Hello" });

    expect(calls).toEqual(["create", "ready", "load", "send", "sync"]);
  });
});

describe("archiveCurrentConversation", () => {
  it("archives once, falls back selection, then refreshes Recent", async () => {
    const order: string[] = [];
    const deps = {
      archiveThread: vi.fn(async () => { order.push("archive"); return { threadId: "t1", status: "archived" }; }),
      onArchived: vi.fn(() => { order.push("fallback"); }),
      syncThreads: vi.fn(async () => { order.push("sync"); }),
      onError: vi.fn(),
    };

    await archiveCurrentConversation(deps, "t1");

    expect(deps.archiveThread).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["archive", "fallback", "sync"]);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("keeps the thread open and reports the error when archive fails", async () => {
    const deps = {
      archiveThread: vi.fn(async () => { throw new Error("Archive service unavailable"); }),
      onArchived: vi.fn(),
      syncThreads: vi.fn(async () => {}),
      onError: vi.fn(),
    };

    await archiveCurrentConversation(deps, "t1");

    expect(deps.archiveThread).toHaveBeenCalledTimes(1);
    expect(deps.onArchived).not.toHaveBeenCalled();
    expect(deps.syncThreads).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith("Archive service unavailable");
  });
});

describe("Intentional loading / error states (no blank panels)", () => {
  const noop = async () => {};

  it("shows a loading workspace instead of a fake zero-agent state", () => {
    currentReady = false;
    const html = renderToString(<AgentsView />);
    expect(html).toContain("Loading workspace");
    expect(html).not.toContain("Create your first Agent");
  });

  it("shows a truthful error state when the backend is unavailable and no agents exist", () => {
    currentReady = false;
    currentError = "Control Plane unreachable";
    currentAgents = [];
    const html = renderToString(<AgentsView />);
    expect(html).toContain("Workspace unavailable");
    expect(html).toContain("Control Plane unreachable");
    // The hub hides its creation CTA on backend failure (the separate footer
    // action remains as workspace chrome).
    expect(html).not.toContain("Create your first Agent");
  });

  it("shows a message loading state instead of an empty chat", () => {
    const html = renderToString(
      <AgentDetail
        summary={fixtureAgent("a1", "Research Agent")}
        threadId="t1"
        messagesLoading
        onThreadChange={noop}
        onNewChat={noop}
        onStartFirstMessage={noop}
      />,
    );
    expect(html).toContain("Loading conversation");
    expect(html).not.toContain("Ready when you are");
  });

  it("surfaces failed thread loads with a retry affordance", () => {
    const onReloadThread = vi.fn();
    const html = renderToString(
      <AgentDetail
        summary={fixtureAgent("a1", "Research Agent")}
        threadId="t1"
        threadLoadError="Thread service unavailable"
        onReloadThread={onReloadThread}
        onThreadChange={noop}
        onNewChat={noop}
        onStartFirstMessage={noop}
      />,
    );
    expect(html).toContain("could not be loaded");
    expect(html).toContain("Thread service unavailable");
    expect(html).toContain("Retry");
  });
});

describe("No dead controls in the Agents workspace", () => {
  const noop = async () => {};

  it("has no href=\"#\" actions left (Create Agent is a real button)", () => {
    const html = renderToString(<AgentsView />);
    expect(html).not.toContain('href="#"');
    expect(html).toContain('aria-label="Create Agent"');
  });

  it("removed the Add context no-op from the active composer", () => {
    const html = renderToString(
      <AgentDetail
        summary={fixtureAgent("a1", "Research Agent")}
        threadId="t1"
        onThreadChange={noop}
        onNewChat={noop}
        onStartFirstMessage={noop}
      />,
    );
    expect(html).not.toContain("Add context");
  });

  it("renders the model badge as non-interactive (no dropdown chevron)", () => {
    const summary = { ...fixtureAgent("a1", "Research Agent"), modelBadge: "gpt-4.1" } as AgentSummary;
    const html = renderToString(
      <AgentDetail
        summary={summary}
        threadId="t1"
        onThreadChange={noop}
        onNewChat={noop}
        onStartFirstMessage={noop}
      />,
    );
    expect(html).toContain("aw-model-badge");
    expect(html).toContain("change it in Settings");
    const start = html.indexOf('class="aw-model-badge"');
    const end = html.indexOf("</div>", start);
    expect(start).toBeGreaterThan(-1);
    expect(html.slice(start, end)).not.toContain("<svg");
  });

  it("exposes an archive action only for an open thread", () => {
    const onArchive = vi.fn(async () => null);
    const withThread = renderToString(
      <AgentDetail
        summary={fixtureAgent("a1", "Research Agent")}
        threadId="t1"
        onArchive={onArchive}
        onThreadChange={noop}
        onNewChat={noop}
        onStartFirstMessage={noop}
      />,
    );
    expect(withThread).toContain('aria-label="Archive conversation"');
    const noThread = renderToString(
      <AgentDetail
        summary={fixtureAgent("a1", "Research Agent")}
        threadId={null}
        onArchive={onArchive}
        onThreadChange={noop}
        onNewChat={noop}
        onStartFirstMessage={noop}
      />,
    );
    expect(noThread).not.toContain('aria-label="Archive conversation"');
  });
});
