import type { ModelCapability, ModelDefinition, ModelId } from "@mox/contracts";

/**
 * Model registry (Prompt 07). One authoritative catalog of providers/models:
 * capabilities, modalities, reasoning levels, context limits, availability,
 * deprecation and region restrictions. Provider health degrades gracefully —
 * an unavailable provider's models resolve but report unavailable.
 */

export const MOX_AI_ALIASES = ["mox-fast", "mox-agent", "mox-code", "mox-reasoning"] as const;
export type MoxAiAlias = (typeof MOX_AI_ALIASES)[number];

export interface RegistryEntry {
  definition: ModelDefinition;
  /** Runtime availability (health/config), independent of catalog status. */
  available: boolean;
  unavailableReason?: string;
}

export class ModelRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly aliases = new Map<string, { providerId: string; modelId: ModelId }>();

  register(definition: ModelDefinition, opts: { available?: boolean; unavailableReason?: string } = {}): void {
    this.entries.set(key(definition.providerId, definition.modelId), {
      definition,
      available: opts.available ?? true,
      unavailableReason: opts.unavailableReason,
    });
  }

  /**
   * Register a Mox AI alias. Aliases WITHOUT a backend target stay
   * resolvable-but-unavailable: the gateway answers honestly that hosted
   * inference is not configured rather than faking it.
   */
  registerAlias(alias: MoxAiAlias, target?: { providerId: string; modelId: ModelId }): void {
    if (target) {
      this.aliases.set(alias, target);
    } else {
      // Explicitly unconfigured: delete any stale target so resolution fails honestly.
      this.aliases.set(alias, { providerId: "", modelId: "" as never });
    }
  }

  resolve(providerId: string, modelId: string): RegistryEntry | undefined {
    return this.entries.get(key(providerId, modelId));
  }

  /** Resolve possibly-aliased selection; undefined when unknown. */
  resolveSelection(providerId: string, modelId: string): RegistryEntry | undefined {
    if (MOX_AI_ALIASES.includes(modelId as never)) {
      const target = this.aliases.get(modelId);
      if (!target || target.providerId === "") return undefined; // alias exists, no backend
      return this.resolve(target.providerId, target.modelId);
    }
    return this.resolve(providerId, modelId);
  }

  list(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }

  listForProvider(providerId: string): RegistryEntry[] {
    return this.list().filter((e) => e.definition.providerId === providerId);
  }

  /** Capability filter for UI pickers and runtime tool negotiation. */
  findByCapability(cap: ModelCapability): RegistryEntry[] {
    return this.list().filter(
      (e) => e.available && e.definition.status === "active" && e.definition.capabilities.includes(cap),
    );
  }

  /**
   * Availability check used by the gateway BEFORE dispatch:
   * deprecated status warns, region mismatch or unavailable health blocks.
   */
  checkDispatchable(entry: RegistryEntry, ctx: { region?: string }): { ok: boolean; reason?: string } {
    if (!entry.available) {
      return { ok: false, reason: entry.unavailableReason ?? "model currently unavailable" };
    }
    if (entry.definition.regions && ctx.region && !entry.definition.regions.includes(ctx.region)) {
      return { ok: false, reason: `model not served in region ${ctx.region}` };
    }
    return { ok: true };
  }

  isDeprecated(entry: RegistryEntry): boolean {
    return entry.definition.status === "deprecated";
  }
}

function key(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}
