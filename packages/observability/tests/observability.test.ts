import { describe, expect, it } from "vitest";
import { SPAN_NAMES, Tracer, withSpan, type FinishedSpan, type MetricPoint } from "../src/index.js";

function capturing() {
  const spans: FinishedSpan[] = [];
  const metrics: MetricPoint[] = [];
  const tracer = new Tracer("mox-test");
  tracer.addExporter({
    exportSpan(span) {
      spans.push(span);
    },
    exportMetric(point) {
      metrics.push(point);
    },
  });
  return { tracer, spans, metrics };
}

describe("observability", () => {
  it("records ok spans with duration for critical paths", async () => {
    const { tracer, spans } = capturing();
    await withSpan(tracer, SPAN_NAMES.vpsProvision, { "mox.org": "org-1" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "instance-id";
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("mox.compute.provision");
    expect(spans[0]?.status).toBe("ok");
    expect(spans[0]?.durationMs).toBeGreaterThanOrEqual(4);
    expect(spans[0]?.attributes["service.name"]).toBe("mox-test");
  });

  it("records error status and rethrows so failures are never swallowed", async () => {
    const { tracer, spans } = capturing();
    await expect(
      withSpan(tracer, SPAN_NAMES.webhookApplied, {}, async () => {
        throw new Error("signature mismatch");
      }),
    ).rejects.toThrow(/signature mismatch/);
    expect(spans[0]?.status).toBe("error");
    expect(spans[0]?.errorMessage).toContain("signature mismatch");
  });

  it("propagates trace ids across child spans", async () => {
    const { tracer, spans } = capturing();
    const parent = tracer.startSpan(SPAN_NAMES.checkoutCreated);
    const child = tracer.startSpan(SPAN_NAMES.entitlementResolved, {}, parent.context);
    parent.end();
    child.end();
    void spans;
    // Child shares the parent's trace id and references its span id.
    expect(child.context.traceId).toBe(parent.context.traceId);
    expect(child.context.parentSpanId).toBe(parent.context.spanId);
  });

  it("exports counter/histogram metric points", () => {
    const { tracer, metrics } = capturing();
    tracer.metric("mox.billing.webhooks.total").counter(1, { outcome: "applied" });
    tracer.metric("mox.billing.webhook.duration_ms").histogram(123);
    expect(metrics.map((m) => m.kind)).toEqual(["counter", "histogram"]);
    expect(metrics[0]?.attributes.outcome).toBe("applied");
    expect(metrics[1]?.value).toBe(123);
  });

  it("covers every required critical-path name", () => {
    expect(Object.values(SPAN_NAMES)).toContain("mox.node.enroll");
    expect(Object.values(SPAN_NAMES)).toContain("mox.agent.run");
    expect(Object.values(SPAN_NAMES)).toContain("mox.model.call");
    expect(Object.values(SPAN_NAMES)).toContain("mox.computer.action");
    expect(Object.values(SPAN_NAMES)).toContain("mox.channel.webhook");
    expect(Object.values(SPAN_NAMES)).toContain("mox.integration.tool_call");
    expect(Object.values(SPAN_NAMES)).toContain("mox.backup.run");
  });

  it("exporter failures never break traced operations", async () => {
    const tracer = new Tracer("mox-broken-exporter");
    tracer.addExporter({
      exportSpan: () => {
        throw new Error("collector down");
      },
      exportMetric: () => {
        throw new Error("collector down");
      },
    });
    const result = await withSpan(tracer, "op", {}, async () => 42);
    expect(result).toBe(42);
  });
});
