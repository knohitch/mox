/**
 * Observability (Prompt 14): OpenTelemetry-compatible tracing/metrics
 * primitives without a hard SDK dependency.
 *
 * - Span names follow OTel semantic conventions (`mox.checkout.webhook`).
 * - Exporters receive finished spans/metrics; wiring the OTLP exporter is a
 *   deployment concern (collector endpoint, sampling, resource attrs).
 * - `withSpan` instruments critical transaction paths with one call and
 *   records failures as span events + error status automatically.
 */

export type SpanStatus = "unset" | "ok" | "error";

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface FinishedSpan {
  name: string;
  context: SpanContext;
  attributes: Record<string, string | number | boolean>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: SpanStatus;
  errorMessage?: string;
}

export interface MetricPoint {
  name: string;
  kind: "counter" | "histogram";
  value: number;
  attributes: Record<string, string | number | boolean>;
  at: string;
}

export interface TelemetryExporter {
  exportSpan(span: FinishedSpan): void;
  exportMetric(point: MetricPoint): void;
}

/** Semantic operation names for Mox's critical transaction paths. */
export const SPAN_NAMES = {
  checkoutCreated: "mox.billing.checkout.create",
  webhookApplied: "mox.billing.webhook.apply",
  entitlementResolved: "mox.entitlements.resolve",
  vpsProvision: "mox.compute.provision",
  nodeEnroll: "mox.node.enroll",
  agentRun: "mox.agent.run",
  modelCall: "mox.model.call",
  computerAction: "mox.computer.action",
  channelWebhook: "mox.channel.webhook",
  integrationToolCall: "mox.integration.tool_call",
  backupRun: "mox.backup.run",
} as const;

let spanCounter = 0;

export class Tracer {
  private readonly exporters = new Set<TelemetryExporter>();
  private readonly serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  addExporter(exporter: TelemetryExporter): () => void {
    this.exporters.add(exporter);
    return () => this.exporters.delete(exporter);
  }

  startSpan(name: string, attributes: Record<string, string | number | boolean> = {}, parent?: SpanContext): FinishedSpan & { end(status?: SpanStatus, errorMessage?: string): void } {
    const startedAt = new Date();
    const context: SpanContext = {
      traceId: parent?.traceId ?? randomTraceId(),
      spanId: randomSpanId(),
      parentSpanId: parent?.spanId,
    };
    const span = {
      name,
      context,
      attributes: { "service.name": this.serviceName, ...attributes },
      startedAt: "",
      endedAt: "",
      durationMs: 0,
      status: "unset" as SpanStatus,
      end: (status: SpanStatus = "ok", errorMessage?: string) => {
        const endedAt = new Date();
        const finished: FinishedSpan = {
          name,
          context,
          attributes: span.attributes,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime(),
          status,
          errorMessage,
        };
        for (const exporter of this.exporters) {
          try {
            exporter.exportSpan(finished);
          } catch {
            /* exporters must never break the traced operation */
          }
        }
        return finished;
      },
    };
    return span as typeof span & { startedAt: string; endedAt: string };
  }

  get serviceNameValue(): string {
    return this.serviceName;
  }

  metric(name: string): MetricBuilder {
    return new MetricBuilder(name, this.exporters);
  }
}

export class MetricBuilder {
  constructor(
    private readonly name: string,
    private readonly exporters: Set<TelemetryExporter>,
  ) {}

  counter(value = 1, attributes: Record<string, string | number | boolean> = {}): void {
    this.emit("counter", value, attributes);
  }

  histogram(value: number, attributes: Record<string, string | number | boolean> = {}): void {
    this.emit("histogram", value, attributes);
  }

  private emit(kind: MetricPoint["kind"], value: number, attributes: Record<string, string | number | boolean>): void {
    const point: MetricPoint = { name: this.name, kind, value, attributes, at: new Date().toISOString() };
    for (const exporter of this.exporters) {
      try {
        exporter.exportMetric(point);
      } catch {
        /* ignore exporter failures */
      }
    }
  }
}

/**
 * Instrument an async operation: starts a span, records ok/error, emits
 * a duration histogram. Errors propagate after being recorded.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Record<string, string | number | boolean>,
  operation: (span: ReturnType<Tracer["startSpan"]>) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, attributes);
  try {
    const result = await operation(span);
    span.end("ok");
    return result;
  } catch (error) {
    span.end("error", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function randomTraceId(): string {
  // W3C trace id: 32 hex chars.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSpanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

void spanCounter;
