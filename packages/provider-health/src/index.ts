/**
 * Provider health scoring (Prompt 13).
 *
 * Tracks operation outcomes and latencies for ANY provider class — compute,
 * model, channel or integration — and derives a 0–100 health score from:
 *   failure rate, average latency, provisioning success/time (compute),
 *   incident state, capacity headroom and last-successful-operation recency.
 *
 * Scores feed safe auto-selection: callers must still enforce commercial
 * approval, entitlement compatibility, region compatibility and capacity;
 * health only ranks among already-eligible providers.
 */

export interface OperationObservation {
  providerName: string;
  accountLabel?: string;
  operation: string;
  ok: boolean;
  latencyMs: number;
  at: string;
}

export type IncidentState = "none" | "minor" | "major" | "critical";

export interface CapacitySignal {
  /** Free slots / total slots in [0,1]; undefined when unknown. */
  headroom?: number;
}

export interface ProviderHealthRecord {
  providerName: string;
  score: number; // 0..100
  state: "healthy" | "degraded" | "offline";
  failureRatePct: number;
  avgLatencyMs: number;
  lastSuccessAt?: string;
  incidentState: IncidentState;
  updatedAt: string;
}

export interface ProviderHealthStore {
  append(observation: OperationObservation): Promise<void>;
  setIncident(providerName: string, state: IncidentState): Promise<void>;
  setCapacity(providerName: string, signal: CapacitySignal): Promise<void>;
  observations(providerName: string): Promise<OperationObservation[]>;
  incidentOf(providerName: string): Promise<IncidentState>;
  capacityOf(providerName: string): Promise<CapacitySignal>;
}

const MAX_OBSERVATIONS = 500;

/** Observations older than this no longer count toward the score. */
const WINDOW_MS = 30 * 60_000;

export class InMemoryProviderHealthStore implements ProviderHealthStore {
  private readonly obs = new Map<string, OperationObservation[]>();
  private readonly incidents = new Map<string, IncidentState>();
  private readonly capacities = new Map<string, CapacitySignal>();

  async append(observation: OperationObservation): Promise<void> {
    const list = this.obs.get(observation.providerName) ?? [];
    list.push(observation);
    if (list.length > MAX_OBSERVATIONS) list.splice(0, list.length - MAX_OBSERVATIONS);
    this.obs.set(observation.providerName, list);
  }

  async setIncident(providerName: string, state: IncidentState): Promise<void> {
    this.incidents.set(providerName, state);
  }

  async setCapacity(providerName: string, signal: CapacitySignal): Promise<void> {
    this.capacities.set(providerName, signal);
  }

  async observations(providerName: string): Promise<OperationObservation[]> {
    return [...(this.obs.get(providerName) ?? [])];
  }

  async incidentOf(providerName: string): Promise<IncidentState> {
    return this.incidents.get(providerName) ?? "none";
  }

  async capacityOf(providerName: string): Promise<CapacitySignal> {
    return this.capacities.get(providerName) ?? {};
  }
}

export interface HealthWeights {
  failureRateWeight?: number;
  latencyWeight?: number;
  recencyWeight?: number;
  incidentPenaltyMax?: number;
  capacityWeight?: number;
  /** Latency considered perfect / worst for scoring. */
  goodLatencyMs?: number;
  badLatencyMs?: number;
  offlineAfterFailureRatePct?: number;
}

const DEFAULTS: Required<Omit<HealthWeights, "capacityWeight">> & { capacityWeight: number } = {
  failureRateWeight: 45,
  latencyWeight: 20,
  recencyWeight: 10,
  incidentPenaltyMax: 25,
  capacityWeight: 0,
  goodLatencyMs: 300,
  badLatencyMs: 8000,
  offlineAfterFailureRatePct: 80,
};

export class ProviderHealthScorer {
  readonly store: ProviderHealthStore;
  private readonly weights: ReturnType<typeof resolveDefaults>;

  constructor(store: ProviderHealthStore = new InMemoryProviderHealthStore(), weights: HealthWeights = {}) {
    this.store = store;
    this.weights = resolveDefaults(weights);
  }

  reportIncident(providerName: string, state: IncidentState): Promise<void> {
    return this.store.setIncident(providerName, state);
  }

  reportCapacity(providerName: string, signal: CapacitySignal): Promise<void> {
    return this.store.setCapacity(providerName, signal);
  }

  record(observation: OperationObservation): Promise<void> {
    return this.store.append(observation);
  }

  /** Compute the current health snapshot for one provider. */
  async evaluate(providerName: string, nowIso?: string): Promise<ProviderHealthRecord> {
    const at = nowIso ? Date.parse(nowIso) : Date.now();
    const all = await this.store.observations(providerName);
    const recent = all.filter((o) => at - Date.parse(o.at) <= WINDOW_MS);

    let failureRatePct = 0;
    let avgLatencyMs = 0;
    if (recent.length > 0) {
      const failures = recent.filter((o) => !o.ok).length;
      failureRatePct = (failures / recent.length) * 100;
      avgLatencyMs = recent.reduce((sum, o) => sum + o.latencyMs, 0) / recent.length;
    }
    const lastSuccessAt =
      [...all].reverse().find((o) => o.ok)?.at ?? undefined;

    // Component scores start at perfect and lose points.
    let score = 100;
    score -= (failureRatePct / 100) * this.weights.failureRateWeight * 2; // 50% failures ≈ full penalty

    const latencyRatio = clamp(
      (avgLatencyMs - this.weights.goodLatencyMs) /
        Math.max(1, this.weights.badLatencyMs - this.weights.goodLatencyMs),
    );
    score -= latencyRatio * this.weights.latencyWeight;

    // Recency of the last success: decays over the window.
    if (lastSuccessAt) {
      const ageRatio = clamp((at - Date.parse(lastSuccessAt)) / WINDOW_MS);
      score -= ageRatio * this.weights.recencyWeight;
    } else if (recent.length === 0 && all.length === 0) {
      score -= this.weights.recencyWeight / 2; // unknown provider: mildly penalized, not dead
    } else {
      score -= this.weights.recencyWeight; // has traffic but never succeeded
    }

    const incidentState = await this.store.incidentOf(providerName);
    const incidentMultiplier =
      incidentState === "critical" ? 1 : incidentState === "major" ? 0.6 : incidentState === "minor" ? 0.3 : 0;
    score -= incidentMultiplier * this.weights.incidentPenaltyMax;

    const capacity = await this.store.capacityOf(providerName);
    if (capacity.headroom !== undefined && this.weights.capacityWeight > 0) {
      score -= (1 - clamp(capacity.headroom)) * this.weights.capacityWeight;
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    if (recent.length === 0 && all.length === 0) {
      // No data at all: report degraded-neutral so selection prefers proven
      // providers but an unknown provider is not auto-ranked above healthy ones.
      return {
        providerName,
        score,
        state: "degraded",
        failureRatePct: 0,
        avgLatencyMs: 0,
        lastSuccessAt,
        incidentState,
        updatedAt: new Date(at).toISOString(),
      };
    }

    const state: ProviderHealthRecord["state"] =
      failureRatePct >= this.weights.offlineAfterFailureRatePct || incidentState === "critical"
        ? "offline"
        : score < 70 || incidentState !== "none"
          ? "degraded"
          : "healthy";

    return {
      providerName,
      score,
      state,
      failureRatePct: Number(failureRatePct.toFixed(2)),
      avgLatencyMs: Math.round(avgLatencyMs),
      lastSuccessAt,
      incidentState,
      updatedAt: new Date(at).toISOString(),
    };
  }

  /**
   * Rank candidates best-first by health score. Selection policy lives with
   * the caller; this only orders.
   */
  async rank(providerNames: string[], nowIso?: string): Promise<Array<{ providerName: string; record: ProviderHealthRecord }>> {
    const evaluated = await Promise.all(
      providerNames.map(async (providerName) => ({ providerName, record: await this.evaluate(providerName, nowIso) })),
    );
    return evaluated.sort((a, b) => b.record.score - a.record.score);
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function resolveDefaults(weights: HealthWeights) {
  return { ...DEFAULTS, ...weights };
}
