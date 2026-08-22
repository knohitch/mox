/**
 * CLI command implementations. Each command receives its dependencies so
 * tests can drive the full surface against a fake API client.
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
      io.print(formatJson(await api.request("GET", "/v1/whoami")));
    },
  },
  {
    name: "orgs",
    summary: "List organizations",
    usage: "mox orgs list",
    async run({ api, args, io }) {
      if (args[0] !== "list") throw new Error("usage: mox orgs list");
      io.print(formatJson(await api.request("GET", "/v1/orgs")));
    },
  },
  {
    name: "servers",
    summary: "List or get servers",
    usage: "mox servers list | mox servers get <id>",
    async run({ api, args, io }) {
      if (args[0] === "list") {
        io.print(formatJson(await api.request("GET", "/v1/servers")));
        return;
      }
      if (args[0] === "get") {
        const id = requireArg(args, 1, "server-id");
        io.print(formatJson(await api.request("GET", `/v1/servers/${encodeURIComponent(id)}`)));
        return;
      }
      throw new Error("usage: mox servers list | mox servers get <id>");
    },
  },
  {
    name: "agents",
    summary: "Agent CRUD",
    usage: "mox agents list|get <slug>|create <json-file>|update <slug> <json-file>",
    async run({ api, args, io }) {
      switch (args[0]) {
        case "list":
          io.print(formatJson(await api.request("GET", "/v1/agents")));
          return;
        case "get": {
          const slug = requireArg(args, 1, "agent-slug");
          io.print(formatJson(await api.request("GET", `/v1/agents/${encodeURIComponent(slug)}`)));
          return;
        }
        case "create": {
          const file = requireArg(args, 1, "definition.json");
          const body = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")));
          io.print(formatJson(await api.request("POST", "/v1/agents", body)));
          return;
        }
        case "update": {
          const slug = requireArg(args, 1, "agent-slug");
          const file = requireArg(args, 2, "definition.json");
          const body = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")));
          io.print(formatJson(await api.request("PATCH", `/v1/agents/${encodeURIComponent(slug)}`, body)));
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
    usage: "mox deploy <slug> --revision <n>",
    async run({ api, args, flags, io }) {
      const slug = requireArg(args, 0, "agent-slug");
      const revision = Number(flags.revision ?? "latest");
      io.print(
        formatJson(
          await api.request("POST", `/v1/agents/${encodeURIComponent(slug)}/deployments`, { revision }),
        ),
      );
    },
  },
  {
    name: "deployment",
    summary: "Deployment status",
    usage: "mox deployment status <deployment-id>",
    async run({ api, args, io }) {
      if (args[0] !== "status") throw new Error("usage: mox deployment status <id>");
      const id = requireArg(args, 1, "deployment-id");
      io.print(formatJson(await api.request("GET", `/v1/deployments/${encodeURIComponent(id)}`)));
    },
  },
  {
    name: "logs",
    summary: "Stream or fetch agent logs",
    usage: "mox logs <deployment-id>",
    async run({ api, args, io }) {
      const id = requireArg(args, 0, "deployment-id");
      io.print(formatJson(await api.request("GET", `/v1/deployments/${encodeURIComponent(id)}/logs`)));
    },
  },
  {
    name: "models",
    summary: "List model connections",
    usage: "mox models connections",
    async run({ api, args, io }) {
      if (args[0] !== "connections") throw new Error("usage: mox models connections");
      io.print(formatJson(await api.request("GET", "/v1/models/connections")));
    },
  },
  {
    name: "channels",
    summary: "List channel connections",
    usage: "mox channels list",
    async run({ api, args, io }) {
      if (args[0] !== "list") throw new Error("usage: mox channels list");
      io.print(formatJson(await api.request("GET", "/v1/channels")));
    },
  },
  {
    name: "integrations",
    summary: "List integrations",
    usage: "mox integrations list",
    async run({ api, args, io }) {
      if (args[0] !== "list") throw new Error("usage: mox integrations list");
      io.print(formatJson(await api.request("GET", "/v1/integrations")));
    },
  },
  {
    name: "terminal",
    summary: "Open a browser terminal session to an owned server (entitlement-gated server-side)",
    usage: "mox terminal <server-id>",
    async run({ api, args, io }) {
      const id = requireArg(args, 0, "server-id");
      // The SERVER validates entitlements and ownership; the CLI only asks.
      io.print(formatJson(await api.request("POST", `/v1/servers/${encodeURIComponent(id)}/terminal`, {})));
    },
  },
];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}
