import { InMemoryTokenStore, formatJson, type ApiClient, type CliIo } from "./api.js";
import { commands, findCommand } from "./commands.js";

export type { CliIo };

export interface MainOptions {
  argv: string[];
  api: ApiClient;
  tokens?: InMemoryTokenStore;
  io?: CliIo;
}

export async function main(options: MainOptions): Promise<number> {
  const io = options.io ?? { print: console.log, error: console.error };
  const [name = "", ...rest] = options.argv;
  if (!name || name === "help" || name === "--help") {
    io.print("Mox CLI — usage: mox <command> [args] [--flags]");
    for (const command of commands) {
      io.print(`  ${command.usage.padEnd(58)} ${command.summary}`);
    }
    return 0;
  }

  const command = findCommand(name);
  if (!command) {
    io.error(`unknown command: ${name} (try 'mox help')`);
    return 1;
  }

  const args = rest.filter((a) => !a.startsWith("--"));
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg?.startsWith("--")) {
      flags[arg.slice(2)] = rest[i + 1] ?? "true";
      i += 1;
    }
  }

  try {
    await command.run({ api: options.api, tokens: options.tokens ?? new InMemoryTokenStore(), io, args, flags });
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export { formatJson };
