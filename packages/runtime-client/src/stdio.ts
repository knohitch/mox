import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { scrubLogLine } from "@mox/security";
import { RuntimeClient, type RuntimeTransport } from "./client.js";
import { frame } from "./client.js";

/**
 * Stdio transport: launches the runtime executable and speaks
 * newline-delimited JSON-RPC over its stdin/stdout. Stderr is captured for
 * diagnostics only — it is never parsed as protocol traffic, and any
 * stderr that reaches errors/API surfaces is SCRUBBED (Security Repair 05B
 * §E): bearer tokens, keys, passwords, DB URLs, cookies, JWTs and PEM
 * blocks never leave the process; the bounded sanitized tail is exposed
 * with an optional SHA-256 of the raw diagnostic for transient matching.
 */
export interface RuntimeCrashDiagnostic {
  component: "stdio-runtime";
  operation: "run";
  exitCode: number | null;
  signalCode: string | null;
  correlationId?: string;
  diagnostic: string;
  /** sha256 of the FULL raw stderr tail — transient correlation only. */
  rawDiagnosticSha256: string;
}

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
      this.child.once("close", (code, signal) =>
        resolve(code === 0 ? undefined : new Error(`runtime exited with code ${code}: ${this.scrubbedTail().slice(-2000)}`)),
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

  /** Bounded, SCRUBBED stderr tail — safe for hosts/tests. */
  stderrTailText(): string {
    return this.scrubbedTail();
  }

  /** Structured crash record: sanitized diagnostic + transient raw digest. */
  crashDiagnostic(correlationId?: string): RuntimeCrashDiagnostic {
    return {
      component: "stdio-runtime",
      operation: "run",
      exitCode: this.child.exitCode,
      signalCode: this.child.signalCode,
      correlationId,
      diagnostic: this.scrubbedTail().slice(-2000),
      rawDiagnosticSha256: createHash("sha256").update(this.stderrTail, "utf8").digest("hex"),
    };
  }

  private scrubbedTail(): string {
    return scrubLogLine(this.stderrTail);
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
