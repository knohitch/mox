import { randomUUID } from "node:crypto";
import {
  ApprovalRespondRequest,
  ApprovalRespondResult,
  CapabilitiesRequest,
  CapabilitiesResult,
  HealthRequest,
  HealthResult,
  RPC_ERROR,
  RpcId,
  RpcNotification,
  RpcRequest,
  RpcResponse,
  RunCancelRequest,
  RunCancelResult,
  RunListRequest,
  RunListResult,
  RunResumeRequest,
  RunResumeResult,
  RunStartRequest,
  RunStartResult,
  ShutdownRequest,
  ShutdownResult,
  STREAM_NOTIFICATION,
  StreamEventParams,
} from "./protocol.js";

/**
 * Transport abstraction for the Mox runtime protocol. A transport moves
 * framed JSON-RPC messages to/from the runtime process. The default
 * implementation is newline-delimited JSON over stdio; tests substitute an
 * in-memory transport.
 */
export interface RuntimeTransport {
  /** Send one raw JSON-serializable message to the runtime. */
  send(message: unknown): Promise<void>;
  /** Register the handler invoked for every message from the runtime. */
  onMessage(handler: (message: unknown) => void): void;
  /** Resolve when the underlying stream/process has closed; error if abnormal. */
  onClosed(): Promise<Error | undefined>;
  close(): Promise<void>;
}

export class TransportClosedError extends Error {
  constructor() {
    super("runtime transport closed");
    this.name = "TransportClosedError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
};

export interface RuntimeClientOptions {
  timeoutMs?: number;
}

/**
 * Typed client for the Mox runtime wire protocol. The Control Plane depends
 * on this class only — never on DSH or any other runtime's internals.
 */
export class RuntimeClient {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly eventListeners = new Set<(params: StreamEventParams) => void>();
  private closedHandler: ((error: Error) => void) | undefined;

  constructor(
    private readonly transport: RuntimeTransport,
    private readonly options: RuntimeClientOptions = {},
  ) {
    transport.onMessage((raw) => this.handleMessage(raw));
  }

  /** Fires for each canonical AgentEvent streamed by the runtime. */
  onEvent(listener: (params: StreamEventParams) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Fires once when the transport closes (crash or graceful exit). */
  onClosed(handler: (error: Error) => void): void {
    this.closedHandler = handler;
    void this.transport.onClosed().then((error) => {
      const err = error ?? new TransportClosedError();
      for (const pending of Array.from(this.pending.values())) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
      handler(err);
    });
  }

  async health(): Promise<HealthResult> {
    const params = HealthRequest.parse({});
    return HealthResult.parse(await this.call("runtime/health", params));
  }

  async capabilities(): Promise<CapabilitiesResult> {
    const params = CapabilitiesRequest.parse({});
    return CapabilitiesResult.parse(await this.call("runtime.capabilities", params));
  }

  async startRun(request: RunStartRequest): Promise<RunStartResult> {
    const parsed = RunStartRequest.parse(request);
    return RunStartResult.parse(await this.call("run.start", parsed));
  }

  async resumeRun(request: RunResumeRequest): Promise<RunResumeResult> {
    const parsed = RunResumeRequest.parse(request);
    return RunResumeResult.parse(await this.call("run.resume", parsed));
  }

  async cancelRun(request: RunCancelRequest): Promise<RunCancelResult> {
    const parsed = RunCancelRequest.parse(request);
    return RunCancelResult.parse(await this.call("run.cancel", parsed));
  }

  async listRuns(request: RunListRequest = {}): Promise<RunListResult> {
    const parsed = RunListRequest.parse(request);
    return RunListResult.parse(await this.call("run.list", parsed));
  }

  async respondApproval(request: ApprovalRespondRequest): Promise<ApprovalRespondResult> {
    const parsed = ApprovalRespondRequest.parse(request);
    return ApprovalRespondResult.parse(await this.call("approval.respond", parsed));
  }

  async shutdown(request: ShutdownRequest = { gracefulTimeoutMs: 10_000 }): Promise<ShutdownResult> {
    const parsed = ShutdownRequest.parse(request);
    return ShutdownResult.parse(await this.call("runtime.shutdown", parsed));
  }

  async dispose(): Promise<void> {
    await this.transport.close();
  }

  // ---- internals ----

  private call(method: string, params: unknown): Promise<unknown> {
    if (this.pending.size > 10_000) {
      return Promise.reject(new Error(`too many in-flight requests (${this.pending.size})`));
    }
    const id: RpcId = this.nextId++;
    const request: RpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        this.options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`runtime request timed out: ${method}`));
            }, this.options.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      void this.transport.send(request).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  private handleMessage(raw: unknown): void {
    const response = RpcResponse.safeParse(raw);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      if (!pending) return; // unsolicited or late response — drop
      this.pending.delete(response.data.id);
      if (response.data.error !== undefined) {
        pending.reject(
          new Error(
            `runtime ${response.data.error.code === RPC_ERROR.runtimeFailure ? "failure" : "error"} ${response.data.error.code}: ${response.data.error.message}`,
          ),
        );
      } else {
        pending.resolve(response.data.result);
      }
      return;
    }
    const notification = RpcNotification.safeParse(raw);
    if (notification.success && notification.data.method === STREAM_NOTIFICATION) {
      const parsed = StreamEventParams.safeParse(notification.data.params);
      if (parsed.success) {
        for (const listener of Array.from(this.eventListeners)) listener(parsed.data);
      }
      // Malformed stream events are dropped: a broken event must not take
      // down the control channel. Counters/sampling land with observability.
    }
  }
}

/** Newline-delimited JSON framing helper shared by stdio transports. */
export function frame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** Generate a run id for launch calls. Exposed so hosts and tests agree. */
export function newRunId(): string {
  return randomUUID();
}
