import type { EntitlementChecker } from "./gateway.js";

/**
 * Reference EntitlementChecker (Prompt 04). The commercial entitlement engine
 * lands with Prompt 08; until then hosts compose this static checker. It is
 * FAIL-CLOSED by construction: capabilities not explicitly enabled are
 * refused, so a forgotten configuration never silently grants computer access.
 */
export class StaticEntitlementChecker implements EntitlementChecker {
  constructor(
    private readonly enabled: {
      computer?: boolean;
      shell?: boolean;
      screencast?: boolean;
    } = {},
    private readonly reason = "capability not enabled for this organization",
  ) {}

  static allowAll(): StaticEntitlementChecker {
    return new StaticEntitlementChecker({ computer: true, shell: true, screencast: true }, "dev allow-all");
  }

  async check(
    orgId: string,
    capability: "computer" | "shell" | "screencast",
  ): Promise<{ entitled: boolean; reason?: string }> {
    if (this.enabled[capability] === true) {
      return { entitled: true };
    }
    return { entitled: false, reason: `${capability}: ${this.reason} (org ${orgId})` };
  }
}
