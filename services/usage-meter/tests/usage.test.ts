import { describe, expect, it } from "vitest";
import { InMemoryUsageStore } from "../src/types.js";
import { UsageMeterService } from "../src/service.js";

const HOUR = 3600_000;

function dims(orgId = "org-1", extra: Partial<Parameters<UsageMeterService["dimensionsFor"]>[0]> = {}) {
  return { orgId, ...extra };
}

describe("usage meter", () => {
  it("ingests idempotently and aggregates hourly buckets with dimensions", async () => {
    const svc = new UsageMeterService(new InMemoryUsageStore());
    const at = "2026-05-01T10:15:00.000Z";
    expect(
      await svc.ingest({ eventId: "u1", kind: "ai_input_tokens", dimensions: dims("org-1", { agentId: "a-1" }), quantity: 120, at }),
    ).toBe("accepted");
    // Duplicate event id is dropped.
    expect(
      await svc.ingest({ eventId: "u1", kind: "ai_input_tokens", dimensions: dims("org-1", { agentId: "a-1" }), quantity: 120, at }),
    ).toBe("duplicate");

    await svc.ingest({ eventId: "u2", kind: "ai_output_tokens", dimensions: dims("org-1", { agentId: "a-1" }), quantity: 80, at });
    const totals = await svc.aggregatePeriod("org-1", new Date(Date.parse(at) - HOUR).toISOString(), new Date(Date.parse(at) + HOUR).toISOString());
    const byKind = Object.fromEntries(totals.map((t) => [t.kind, t.total]));
    expect(byKind.ai_input_tokens).toBe(120);
    expect(byKind.ai_output_tokens).toBe(80);
    expect(totals.every((t) => t.dimensions.agentId === "a-1")).toBe(true);
  });

  it("covers every canonical usage kind without special cases", async () => {
    const svc = new UsageMeterService(new InMemoryUsageStore());
    const kinds = [
      "ai_cache_tokens", "agent_runs", "browser_minutes", "browser_concurrency_peak",
      "cli_sessions", "storage_gb_hours", "workflow_runs", "channel_messages",
      "voice_minutes", "api_requests", "compute_node_hours", "backup_storage_gb",
    ] as const;
    let i = 0;
    for (const kind of kinds) {
      const decision = await svc.ingest({
        eventId: `evt-${kind}`,
        kind,
        dimensions: dims("org-kinds", { providerName: "contabo", serverId: "srv-9" }),
        quantity: 5,
        at: "2026-06-01T00:30:00.000Z",
      });
      expect(decision).toBe(`accepted` as const);
      i += 1;
    }
    expect(i).toBe(kinds.length);
    const total = await svc.consumedTotal("org-kinds", "voice_minutes");
    expect(total).toBe(5);
  });

  it("hard limits block ingestion; soft limits warn with overage pricing ref", async () => {
    const svc = new UsageMeterService(new InMemoryUsageStore());
    await svc.defineLimit({
      orgId: "org-lim",
      planVersionId: "*",
      kind: "ai_output_tokens",
      includedQuantity: 1000,
      softLimitQuantity: 800,
      hardLimitQuantity: 950,
      overagePriceRef: "price_overage_ai_out",
    });

    const at = "2026-07-01T00:00:00.000Z";
    await svc.ingest({ eventId: "l1", kind: "ai_output_tokens", dimensions: dims("org-lim"), quantity: 900, at });
    // Over soft (800): warning state + overage price reference.
    const softCheck = await svc.evaluateLimit({ orgId: "org-lim", planVersionId: "*", kind: "ai_output_tokens" });
    expect(softCheck.state).toBe("over_soft");
    expect(softCheck.overagePriceRef).toBe("price_overage_ai_out");

    // Hard limit blocks the next ingest.
    const blocked = await svc.ingest({ eventId: "l2", kind: "ai_output_tokens", dimensions: dims("org-lim"), quantity: 100, at });
    expect(blocked).toBe("rejected_hard_limit");

    // Unlimited kinds report unlimited.
    const unlimited = await svc.evaluateLimit({ orgId: "org-lim", planVersionId: "*", kind: "api_requests" });
    expect(unlimited.state).toBe("unlimited");
  });

  it("scopes aggregation by tenant so cross-tenant data never mixes", async () => {
    const svc = new UsageMeterService(new InMemoryUsageStore());
    const at = "2026-08-01T05:00:00.000Z";
    await svc.ingest({ eventId: "x1", kind: "channel_messages", dimensions: dims("org-a"), quantity: 3, at });
    await svc.ingest({ eventId: "x2", kind: "channel_messages", dimensions: dims("org-b"), quantity: 7, at });
    expect(await svc.consumedTotal("org-a", "channel_messages")).toBe(3);
    expect(await svc.consumedTotal("org-b", "channel_messages")).toBe(7);
  });
});
