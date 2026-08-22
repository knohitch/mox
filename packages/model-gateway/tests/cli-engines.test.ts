import { describe, expect, it } from "vitest";
import {
  CLI_ENGINES,
  CliEngineConnector,
  type CliFeatureFlags,
} from "../src/index.js";

const allFlags: CliFeatureFlags = { isEnabled: () => true };
const noFlags: CliFeatureFlags = { isEnabled: () => false };

describe("CLI / subscription engine connectors (separate category)", () => {
  it("ships the four official engines with explicit support tiers", () => {
    const connector = new CliEngineConnector(allFlags);
    expect(connector.list().map((e) => e.engineId)).toEqual(["codex", "claude-code", "gemini-cli", "grok-cli"]);
    expect(connector.descriptor("codex").supportTier).toBe("OFFICIAL");
    expect(connector.descriptor("claude-code").supportTier).toBe("API_ONLY");
    expect(connector.descriptor("gemini-cli").supportTier).toBe("EXPERIMENTAL");
    expect(connector.descriptor("grok-cli").supportTier).toBe("UNSUPPORTED");
  });

  it("device login is the ONLY auth mode; cookie scraping has no code path", () => {
    for (const engine of CLI_ENGINES) {
      if (engine.supportTier !== "UNSUPPORTED") {
        expect(engine.authMode).toBe("official-device-login");
      }
    }
    // The connector API surface accepts no cookie/credential material at all.
    const connector = new CliEngineConnector(allFlags);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(connector)).filter((m) => m !== "constructor");
    for (const m of methods) {
      expect(m.startsWith("scrape")).toBe(false);
      expect(m.toLowerCase().includes("cookie")).toBe(false);
    }
  });

  it("hosted usage is feature-flagged per engine", async () => {
    const gated = new CliEngineConnector(noFlags);
    const blocked = await gated.beginDeviceLogin("codex");
    expect(blocked.state).toBe("blocked-by-flag");
    expect(blocked.reason).toContain("cli.codex.hosted");

    const open = new CliEngineConnector(allFlags);
    await expect(open.beginDeviceLogin("codex")).resolves.toMatchObject({
      state: "awaiting-device-authorization",
      connected: false,
    });
  });

  it("unsupported engines point users at the plain API route instead", async () => {
    const connector = new CliEngineConnector(allFlags);
    const res = await connector.beginDeviceLogin("grok-cli");
    expect(res.state).toBe("unsupported");
    expect(res.reason).toContain("p_xai");
  });

  it("authorization completion stays honest about denial/expiry", () => {
    const connector = new CliEngineConnector(allFlags);
    expect(connector.completeDeviceLogin("codex", true)).toMatchObject({ connected: true, state: "connected" });
    expect(connector.completeDeviceLogin("codex", false)).toMatchObject({
      connected: false,
      state: "not-connected",
    });
  });
});
