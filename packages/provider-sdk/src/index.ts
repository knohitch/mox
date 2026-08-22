import type { HealthReport, HealthState } from "@mox/contracts";

/**
 * Provider SDK: shared registration, capability discovery and health
 * semantics for every provider surface (model, computer, compute, channel,
 * integration). Providers are the only place vendor-specific code lives
 * (Architecture Rule 2).
 *
 * Health semantics:
 * - healthy:    fully usable.
 * - degraded:   usable with reduced capability; callers must consult `reason`.
 * - unavailable: must not be selected; scheduling/routing skips it.
 */

export class ProviderUnavailableError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly report: HealthReport,
  ) {
    super(`provider "${providerId}" is ${report.state}${report.reason ? `: ${report.reason}` : ""}`);
    this.name = "ProviderUnavailableError";
  }
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  /** Capability tokens understood by Mox routing (e.g. "chat", "tools"). */
  capabilities: readonly string[];
}

export interface MoxProvider {
  readonly descriptor: ProviderDescriptor;
  /** Discover current capabilities (may narrow over time while degraded). */
  capabilities(): readonly string[];
  checkHealth(): Promise<HealthReport>;
}

const RANK: Record<HealthState, number> = { healthy: 0, degraded: 1, unavailable: 2 };

/** Worst-of aggregation across a set of health states. */
export function aggregateHealth(states: readonly HealthState[]): HealthState {
  return states.reduce<HealthState>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), "healthy");
}

export class ProviderRegistry {
  private readonly providers = new Map<string, MoxProvider>();

  register(provider: MoxProvider): void {
    if (this.providers.has(provider.descriptor.id)) {
      throw new Error(`provider already registered: ${provider.descriptor.id}`);
    }
    this.providers.set(provider.descriptor.id, provider);
  }

  get(id: string): MoxProvider | undefined {
    return this.providers.get(id);
  }

  require(id: string): MoxProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  list(): readonly MoxProvider[] {
    return [...this.providers.values()];
  }

  findByCapability(capability: string): readonly MoxProvider[] {
    return this.list().filter((p) => p.capabilities().includes(capability));
  }

  /**
   * Resolve a usable provider for a capability. Throws
   * ProviderUnavailableError when no healthy/degraded candidate exists.
   */
  async resolve(capability: string): Promise<MoxProvider> {
    const candidates = this.findByCapability(capability);
    let lastReport: HealthReport | undefined;
    for (const candidate of candidates) {
      const report = await candidate.checkHealth();
      if (report.state === "healthy" || report.state === "degraded") return candidate;
      lastReport = report;
    }
    throw new ProviderUnavailableError(
      candidates[0]?.descriptor.id ?? capability,
      lastReport ?? { state: "unavailable", reason: "no providers registered", checkedAt: new Date().toISOString() },
    );
  }
}