import { describe, expect, it } from "vitest";
import { InMemoryProviderHealthStore, ProviderHealthScorer } from "../src/index.js";

const NOW = "2026-08-21T12:00:00.000Z";

function scorer() {
  return new ProviderHealthScorer(new InMemoryProviderHealthStore());
}

async function recordSeries(
  svc: ProviderHealthScorer,
  provider: string,
  results: Array<{ ok: boolean; latencyMs: number }>,
): Promise<void> {
  let minute = 0;
  for (const r of results) {
    await svc.record({
      providerName: provider,
      operation: "provision",
      ok: r.ok,
      latencyMs: r.latencyMs,
      at: new Date(Date.parse(NOW) - (60 - minute) * 1000).toISOString(),
    });
    minute += 1;
  }
}

describe("provider health scoring", () => {
  it("scores healthy providers high with fast successful operations", async () => {
    const svc = await Promise.resolve(scorer());
    await recordSeries(svc, "good", Array.from({ length: 20 }, () => ({ ok: true, latencyMs: 250 })));
    const report = await svc.evaluate("good", NOW);
    expect(report.state).toBe("healthy");
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.failureRatePct).toBe(0);
  });

  it("penalizes failure rates and can mark a provider offline", async () => {
    const svc = scorer();
    const series = Array.from({ length: 10 }, (_, i) =>
      i < 9 ? { ok: false, latencyMs: 500 } : { ok: true, latencyMs: 300 },
    );
    await recordSeries(svc, "broken", series);
    const report = await svc.evaluate("broken", NOW);
    expect(report.failureRatePct).toBe(90);
    expect(report.state).toBe("offline");
    expect(report.score).toBeLessThan(30);
  });

  it("degrades providers under active incidents and recovers after resolution", async () => {
    const svc = scorer();
    await recordSeries(svc, "flaky", Array.from({ length: 10 }, () => ({ ok: true, latencyMs: 400 })));
    await svc.reportIncident("flaky", "major");
    const degraded = await svc.evaluate("flaky", NOW);
    expect(degraded.state).toBe("degraded");

    await svc.reportIncident("flaky", "none");
    const recovered = await svc.evaluate("flaky", NOW);
    expect(recovered.state).toBe("healthy");
    expect(recovered.score).toBeGreaterThan(degraded.score);
  });

  it("treats critical incidents as offline regardless of raw success rate", async () => {
    const svc = scorer();
    await recordSeries(svc, "dark", Array.from({ length: 5 }, () => ({ ok: true, latencyMs: 100 })));
    await svc.reportIncident("dark", "critical");
    const report = await svc.evaluate("dark", NOW);
    expect(report.state).toBe("offline");
  });

  it("marks unknown providers degraded-neutral so proven providers rank higher", async () => {
    const svc = scorer();
    await recordSeries(svc, "proven", Array.from({ length: 8 }, () => ({ ok: true, latencyMs: 200 })));
    const ranked = await svc.rank(["unknown-provider", "proven"], NOW);
    expect(ranked[0]?.providerName).toBe("proven");
    expect(ranked[1]?.record.state).toBe("degraded");
  });

  it("ranks candidates best-first by score", async () => {
    const svc = scorer();
    await recordSeries(svc, "mid", [
      ...Array.from({ length: 7 }, () => ({ ok: true, latencyMs: 600 })),
      ...Array.from({ length: 3 }, () => ({ ok: false, latencyMs: 900 })),
    ]);
    await recordSeries(svc, "top", Array.from({ length: 10 }, () => ({ ok: true, latencyMs: 220 })));
    await recordSeries(svc, "bottom", Array.from({ length: 10 }, () => ({ ok: false, latencyMs: 5000 })));
    const ranked = await svc.rank(["mid", "bottom", "top"], NOW);
    expect(ranked.map((r) => r.providerName)).toEqual(["top", "mid", "bottom"]);
  });

  it("uses capacity headroom when weighted", async () => {
    const full = new ProviderHealthScorer(new InMemoryProviderHealthStore(), { capacityWeight: 15 });
    await full.reportCapacity("packed", { headroom: 0.02 });
    await recordSeries(full, "packed", Array.from({ length: 6 }, () => ({ ok: true, latencyMs: 300 })));
    const report = await full.evaluate("packed", NOW);
    // Capacity penalty pulls the score down but the provider stays usable.
    expect(report.score).toBeLessThan(100);
    expect(report.score).toBeGreaterThan(70);
  });
});
