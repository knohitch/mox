import { describe, expect, it } from "vitest";
import type { HealthReport } from "@mox/contracts";
import { ProviderRegistry, ProviderUnavailableError, aggregateHealth, type MoxProvider } from "../src/index.js";

const now = "2026-08-21T12:00:00Z";

function fakeProvider(id: string, state: HealthReport["state"], capabilities = ["chat"]): MoxProvider {
  return {
    descriptor: { id, displayName: id, capabilities },
    capabilities: () => capabilities,
    checkHealth: async () => ({ state, reason: state === "healthy" ? undefined : `${id} ${state}`, checkedAt: now }),
  };
}

describe("ProviderRegistry", () => {
  it("registers and discovers by capability", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider("a", "healthy"));
    registry.register(fakeProvider("b", "healthy", ["chat", "tools"]));
    expect(registry.findByCapability("tools").map((p) => p.descriptor.id)).toEqual(["b"]);
    expect(() => registry.register(fakeProvider("a", "healthy"))).toThrow(/already registered/);
  });

  it("resolve prefers healthy and accepts degraded", async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider("down", "unavailable"));
    registry.register(fakeProvider("degraded", "degraded"));
    const resolved = await registry.resolve("chat");
    expect(resolved.descriptor.id).toBe("degraded");
  });

  it("resolve throws when everything is unavailable", async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider("down1", "unavailable"));
    await expect(registry.resolve("chat")).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("require throws for unknown providers", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.require("nope")).toThrow(/unknown provider/);
  });
});

describe("aggregateHealth", () => {
  it("returns the worst state", () => {
    expect(aggregateHealth(["healthy", "healthy"])).toBe("healthy");
    expect(aggregateHealth(["healthy", "degraded"])).toBe("degraded");
    expect(aggregateHealth(["healthy", "degraded", "unavailable"])).toBe("unavailable");
  });
});