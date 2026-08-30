import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { AgentsView } from "../src/views/AgentsView.js";
import { CustomerShell } from "../src/shell/CustomerShell.js";
import * as router from "../src/router.js";
import { NavAdapterProvider } from "../src/router.js";

vi.mock("../src/api/store.js", async () => {
  const actual = await vi.importActual("../src/api/store.js");
  return {
    ...(actual as any),
    useMox: () => ({
      me: { displayName: "Test", email: "test@test.com", orgs: [] },
      agents: [
        {
          agentId: "a1",
          status: "active",
          definition: { identity: { displayName: "Agent 1" }, instructions: { text: "Instructions" }, computer: { enabled: false } }
        }
      ],
      api: {
        listThreads: vi.fn().mockResolvedValue([{ threadId: "t1", title: "Test thread" }]),
        createThread: vi.fn(),
        listModels: vi.fn().mockResolvedValue([]),
      }
    }),
    useEntitlements: () => ({}),
    useTerminal: () => false,
    useBrowser: () => false,
    useDeveloperMode: () => false,
  };
});

describe("Agents Workspace & Customer Shell (Prompt 03)", () => {
  it("renders Agents workspace with Recent threads", () => {
    // Just a sanity check that the code evaluates and renders
    const html = renderToString(<AgentsView />);
    expect(html).toContain("Mox Agents");
  });
});
