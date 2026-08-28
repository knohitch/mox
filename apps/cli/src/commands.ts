/**
 * CLI command implementations. Each command receives its dependencies so
 * tests can drive the full surface against a fake API client.
 *
 * Phase 03 §F: every command targets a real public `/api` route on the Mox
 * control plane. There is deliberately no `/v1` surface, no slug-based
 * addressing (row ids only), and no fabricated endpoints — where the public
 * API genuinely lacks a route, the command says so honestly instead of
 * guessing at a URL.
 */

import type { ApiClient, CliIo } from "./api.js";
import { formatJson } from "./api.js";
import type { TokenStore } from "./api.js";

export interface CommandContext {
  api: ApiClient;
  tokens: TokenStore;
  io: CliIo;
  args: string[];
  flags: Record<string, string>;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(ctx: CommandContext): Promise<void>;
}

function requireArg(args: string[], index: number, label: string): string {
  const value = args[index];
  if (!value) throw new Error(`missing <${label}> argument`);
  return value;
}

async function readJsonFile(file: string): Promise<unknown> {
  const fs = await import("node:fs/promises");
  const text = await fs.readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`file ${file} is not valid JSON`);
  }
}

export const commands: Command[] = [
  {
    name: "login",
    summary: "Store an API token for the CLI session",
    usage: "mox login --token <TOKEN>",
    async run({ flags, tokens, io }) {
      const token = flags.token;
      if (!token) throw new Error("usage: mox login --token <TOKEN>");
      await tokens.set(token);
      io.print("logged in");
    },
  },
  {
    name: "logout",
    summary: "Clear stored credentials",
    usage: "mox logout",
    async run({ tokens, io }) {
      await tokens.set(undefined);
      io.print("logged out");
    },
  },
  {
    name: "whoami",
    summary: "Show the authenticated identity",
    usage: "mox whoami",
    async run({ api, io }) {
      io.print(formatJson(await api.request("GET", "/api/me")));
    },
  },
  {
    name: "orgs",
    summary: "Organization commands (public API exposes no listing — switch in the web app)",
    usage: "mox orgs list",
    async run({ io }) {
      throw new Error(
        "unsupported: the public API does not expose an organization listing; " +
          "switch organizations in the web app, then re-login with a token for that org",
      );
    },
  },
  {
    name: "servers",
    summary: "List servers (ordered server detail is not a public route)",
    usage: "mox servers list",
    async run({ api, args, io }) {
      if (args[0] === "list") {
        io.print(formatJson(await api.request("GET", "/api/servers")));
        return;
      }
      if (args[0] === "get") {
        throw new Error(
          "unsupported: server detail is not exposed as a public route; " +
            "use `mox servers list` for the current state",
        );
      }
      throw new Error("usage: mox servers list");
    },
  },
  {
    name: "agents",
    summary: "Agent CRUD by row id",
    usage: "mox agents list|get <id>|create <body.json>|update <id> <body.json>",
    async run({ api, args, io }) {
      switch (args[0]) {
        case "list":
          io.print(formatJson(await api.request("GET", "/api/agents")));
          return;
        case "get":
          io.print(formatJson(await api.request("GET", `/api/agents/${encodeURIComponent(requireArg(args, 1, "agent-id"))}`)));
          return;
        case "create": {
          const body = await readJsonFile(requireArg(args, 1, "body.json"));
          io.print(formatJson(await api.request("POST", "/api/agents/drafts", body)));
          return;
        }
        case "update": {
          const id = requireArg(args, 1, "agent-id");
          const body = await readJsonFile(requireArg(args, 2, "body.json"));
          io.print(formatJson(await api.request("PATCH", `/api/agents/${encodeURIComponent(id)}/draft`, body)));
          return;
        }
        default:
          throw new Error("usage: mox agents list|get|create|update");
      }
    },
  },
  {
    name: "deploy",
    summary: "Deploy a published agent revision",
    usage: "mox deploy <agent-id> --revision <n>",
    async run({ api, args, flags, io }) {
      const agentId = requireArg(args, 0, "agent-id");
      const revision = Number(flags.revision ?? "latest");
      io.print(
        formatJson(
          await api.request("POST", "/api/deployments", { agentId, revision }),
        ),
      );
    },
  },
  {
    name: "deployment",
    summary: "Deployment status (list is public; per-id detail is not a public route)",
    usage: "mox deployment list",
    async run({ api, args, io }) {
      if (args[0] === "list") {
        io.print(formatJson(await api.request("GET", "/api/deployments")));
        return;
      }
      if (args[0] === "status") {
        throw new Error(
          "unsupported: per-deployment detail is not exposed as a public route; " +
            "use `mox deployment list` for the current state",
        );
      }
      throw new Error("usage: mox deployment list");
    },
  },
  {
    name: "logs",
    summary: "Fetch agent logs (honest 501 when log streaming is not configured)",
    usage: "mox logs <agent-id>",
    async run({ api, args, io }) {
      const id = requireArg(args, 0, "agent-id");
      io.print(formatJson(await api.request("GET", `/api/agents/${encodeURIComponent(id)}/logs`)));
    },
  },
  {
    name: "models",
    summary: "List model connections",
    usage: "mox models connections",
    async run({ api, args, io }) {
      if (args[0] !== "connections") throw new Error("usage: mox models connections");
      io.print(formatJson(await api.request("GET", "/api/model-connections")));
    },
  },
  {
    name: "channels",
    summary: "List channel connections",
    usage: "mox channels list",
    async run({ api, args, io }) {
      if (args[0] !== "list") throw new Error("usage: mox channels list");
      io.print(formatJson(await api.request("GET", "/api/channels")));
    },
  },
  {
    name: "integrations",
    summary: "List integrations",
    usage: "mox integrations list",
    async run({ api, args, io }) {
      if (args[0] !== "list") throw new Error("usage: mox integrations list");
      io.print(formatJson(await api.request("GET", "/api/integrations")));
    },
  },
  {
    name: "terminal",
    summary: "Open a terminal session to an owned agent (entitlement-gated server-side)",
    usage: "mox terminal <agent-id>",
    async run({ api, args, io }) {
      const id = requireArg(args, 0, "agent-id");
      // The SERVER validates entitlements and ownership (and answers honestly
      // when no runtime terminal is configured — 501); the CLI only asks.
      io.print(formatJson(await api.request("POST", `/api/agents/${encodeURIComponent(id)}/terminal`, {})));
    },
  },
];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}