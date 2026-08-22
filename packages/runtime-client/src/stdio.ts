import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { RuntimeClient, type RuntimeTransport } from "./client.js";
import { frame } from "./client.js";

/**
 * Stdio transport: launches the runtime executable and speaks
 * newline-delimited JSON-RPC over its stdin/stdout. Stderr is captured for
 * diagnostics only — it is never parsed as protocol traffic.
 */
export class StdioRuntimeTransport implements RuntimeTransport {
  private readonly child;
  private messageHandler: ((message: unknown) => void) | undefined;
  private closedPromise: Promise<Error | undefined>;
  private stderrTail = "";

  constructor(
    command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
  ) {
    this.child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
    });
    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      try {
        this.messageHandler?.(JSON.parse(trimmed));
      } catch {
        // Non-JSON line on stdout is a protocol violation; drop it rather
        // than crash the control channel. Diagnostics land with observability.
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8000);
    });
    this.closedPromise = new Promise((resolve) => {
      this.child.once("close", (code) =>
        resolve(code === 0 ? undefined : new Error(`runtime exited with code ${code}: ${this.stderrTail.slice(-2000)}`)),
      );
      this.child.once("error", (error) => resolve(error));
    });
  }

  async send(message: unknown): Promise<void> {
    if (this.child.stdin.destroyed) throw new Error("runtime stdin closed");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClosed(): Promise<Error | undefined> {
    return this.closedPromise;
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
    await this.closedPromise;
  }

  /** Last stderr output, bounded — for crash diagnostics in hosts/tests. */
  stderrTailText(): string {
    return this.stderrTail;
  }
}

/** Launch a runtime process and connect a RuntimeClient to it. */
export function launchStdioRuntime(
  command: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
): RuntimeClient {
  const transport = new StdioRuntimeTransport(command, args, options);
  return new RuntimeClient(transport, { timeoutMs: options?.timeoutMs });
}

export { RuntimeClient };
