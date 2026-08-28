/**
 * Canonical entitlement mapping tests (Phase 01 §B / §H).
 *
 * Prove the web consumes canonical entitlement keys (not legacy booleans):
 * numeric values stay numeric, commercial-access denial stays distinct from an
 * entitlement value, and each UX capability derives from the correct canonical
 * key.
 */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_ENTITLEMENT_KEYS,
  hasAgentRooms,
  hasBrowser,
  hasDeveloperMode,
  hasModelConnections,
  hasTerminal,
  hasVoice,
  limitOf,
  type Entitlements,
} from "../src/api/entitlement.js";

function entitled(values: Entitlements["values"] = {}): Entitlements {
  return { commerciallyEntitled: true, values };
}

describe("canonical entitlement representational shape", () => {
  it("exposes the full canonical key set", () => {
    expect(CANONICAL_ENTITLEMENT_KEYS).toContain("browser_sessions");
    expect(CANONICAL_ENTITLEMENT_KEYS).toContain("cli_sessions");
    expect(CANONICAL_ENTITLEMENT_KEYS).toContain("agent_rooms");
    expect(CANONICAL_ENTITLEMENT_KEYS).toContain("model_connections");
    expect(CANONICAL_ENTITLEMENT_KEYS).toContain("voice_minutes");
    expect(CANONICAL_ENTITLEMENT_KEYS).toContain("developer_mode");
    expect(CANONICAL_ENTITLEMENT_KEYS).toContain("team_members");
    expect(CANONICAL_ENTITLEMENT_KEYS).toContain("storage_gb");
  });

  it("preserves numeric values numerically (no boolean collapse)", () => {
    const e = entitled({ max_agents: 5, team_members: 2, storage_gb: 100 });
    expect(e.values.max_agents).toBe(5);
    expect(typeof e.values.max_agents).toBe("number");
    expect(limitOf(e, "max_agents")).toBe(5);
    expect(limitOf(e, "team_members")).toBe(2);
    expect(limitOf(e, "storage_gb")).toBe(100);
  });
});

describe("commercial-access denial is distinct from a value", () => {
  it("returns every capability false when not commercially entitled", () => {
    const denied = { commerciallyEntitled: false, values: { agent_rooms: 2 } } as Entitlements;
    expect(hasAgentRooms(denied)).toBe(false);
    expect(hasBrowser(denied)).toBe(false);
    expect(limitOf(denied, "agent_rooms")).toBe(0);
  });

  it("does not interpret a denied workspace as 'zero of everything' for gating", () => {
    // values are present but irrelevant while denied; gates stay off
    const denied = { commerciallyEntitled: false, values: { browser_sessions: 1 } } as Entitlements;
    expect(hasBrowser(denied)).toBe(false);
  });
});

describe("UX capability derivation from canonical keys", () => {
  it("browser capability derives from browser_sessions", () => {
    expect(hasBrowser(entitled({ browser_sessions: 0 }))).toBe(false);
    expect(hasBrowser(entitled({ browser_sessions: 1 }))).toBe(true);
    expect(hasBrowser(entitled({ browser_sessions: 3 }))).toBe(true);
  });

  it("terminal capability derives from cli_sessions", () => {
    expect(hasTerminal(entitled({ cli_sessions: 0 }))).toBe(false);
    expect(hasTerminal(entitled({ cli_sessions: 2 }))).toBe(true);
  });

  it("rooms capability derives from agent_rooms", () => {
    expect(hasAgentRooms(entitled({ agent_rooms: 0 }))).toBe(false);
    expect(hasAgentRooms(entitled({ agent_rooms: 1 }))).toBe(true);
  });

  it("model connection capability derives from model_connections", () => {
    expect(hasModelConnections(entitled({ model_connections: 0 }))).toBe(false);
    expect(hasModelConnections(entitled({ model_connections: 4 }))).toBe(true);
  });

  it("voice capability derives from voice_minutes", () => {
    expect(hasVoice(entitled({ voice_minutes: 0 }))).toBe(false);
    expect(hasVoice(entitled({ voice_minutes: 100 }))).toBe(true);
  });

  it("developer mode is a truthy boolean key", () => {
    expect(hasDeveloperMode(entitled({ developer_mode: false }))).toBe(false);
    expect(hasDeveloperMode(entitled({ developer_mode: true }))).toBe(true);
    expect(hasDeveloperMode(entitled({ developer_mode: "true" }))).toBe(true);
  });
});
