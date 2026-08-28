/**
 * Phase 01 §G: reusable feature-availability domain model tests.
 *
 * The availability model exists to prevent active-looking buttons that are
 * guaranteed to fail: a feature is `available` only when truly usable, and the
 * honest not-configured / not-entitled / etc. states are never treated as a
 * success path.
 */

import { describe, expect, it } from "vitest";
import {
  AVAILABLE,
  availabilityLabel,
  isAvailable,
  notConfigured,
  notEntitled,
  providerUnavailable,
  roleDenied,
  type FeatureAvailability,
} from "../src/domain/availability.js";

function noop(a: FeatureAvailability): string {
  return isAvailable(a) ? "go" : availabilityLabel(a);
}

describe("feature availability domain (§G)", () => {
  it("only the available state is actionable", () => {
    expect(isAvailable(AVAILABLE)).toBe(true);
    expect(isAvailable(notConfigured())).toBe(false);
    expect(isAvailable(notEntitled())).toBe(false);
    expect(isAvailable(roleDenied())).toBe(false);
    expect(isAvailable(providerUnavailable())).toBe(false);
  });

  it("renders honest labels instead of an active-looking path", () => {
    expect(noop(notConfigured("no api key"))).toBe("Not configured");
    expect(noop(notEntitled("plan lacks browser"))).toBe("Not entitled");
    expect(noop(roleDenied("admin only"))).toBe("Role denied");
    expect(noop(providerUnavailable("gateway down"))).toBe("Provider unavailable");
    expect(noop(AVAILABLE)).toBe("go");
  });

  it("carries the reason through to the caller", () => {
    expect(notConfigured("missing credential").reason).toBe("missing credential");
  });
});
