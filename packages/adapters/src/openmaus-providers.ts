import { healthyReport, ModelProvider, type ModelCapability } from "@mox/contracts";

/**
 * OpenMaus provider metadata → Mox ModelProvider capabilities.
 *
 * Mirrors the driver table OpenMausBot's server maintains for CLI-driven
 * providers (claude/codex/grok/gemini/kimi/droid/cursor over ACP). Structural
 * mirror only — no import from OpenMausBot-main.
 */

export interface OpenMausDriverMeta {
  driver: string;
  binary: string;
  acp: boolean;
  capabilities: readonly ModelCapability[];
}

export const OPENMAUS_DRIVERS: readonly OpenMausDriverMeta[] = [
  { driver: "claude", binary: "claude", acp: true, capabilities: ["chat", "tools", "vision", "streaming"] },
  { driver: "codex", binary: "codex", acp: true, capabilities: ["chat", "tools", "reasoning", "streaming"] },
  { driver: "grok", binary: "grok", acp: true, capabilities: ["chat", "tools", "streaming"] },
  { driver: "gemini", binary: "gemini", acp: true, capabilities: ["chat", "tools", "vision", "streaming"] },
  { driver: "kimi", binary: "kimi", acp: true, capabilities: ["chat", "tools", "streaming"] },
  { driver: "droid", binary: "droid", acp: true, capabilities: ["chat", "tools", "streaming"] },
  { driver: "cursor", binary: "cursor-agent", acp: true, capabilities: ["chat", "tools", "streaming"] },
];

export function openMausDriversToModelProviders(now: string): ModelProvider[] {
  return OPENMAUS_DRIVERS.map((d) =>
    ModelProvider.parse({
      providerId: `openmaus_${d.driver}`,
      displayName: `${d.driver} (CLI)`,
      kind: "cli-proxy",
      capabilities: [...d.capabilities],
      health: healthyReport(now),
      extension: { binary: d.binary, acp: d.acp, source: "openmaus" },
    }),
  );
}