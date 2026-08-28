/**
 * Pure, testable status derivation for connection surfaces (Phase 03 §B–§D).
 * Views render labels/badges exclusively through these helpers — HTTP strings
 * from the control plane stay canonical, UI text derives here.
 */

import type { ChannelCatalogRow, IntegrationCatalogRow, ModelConnectionRow } from "../api/types.js";

export type ConnectionState = "connected" | "disconnected" | "not_configured" | "trouble" | "unavailable";

export function modelConnectionState(row: ModelConnectionRow): ConnectionState {
  if (row.status === "configured" && row.credentialConfigured) return "connected";
  if (row.status === "configured" && !row.credentialConfigured) return "trouble";
  if (row.status === "failing_decryption" || row.status === "error") return "trouble";
  return "not_configured";
}

export function integrationState(row: IntegrationCatalogRow): ConnectionState {
  if (row.connected) return "connected";
  if (row.status === "disconnected") return "disconnected";
  return "not_configured";
}

export function channelState(row: ChannelCatalogRow): ConnectionState {
  if (row.status === "active" && row.connected) return "connected";
  if (row.status === "disconnected") return "disconnected";
  return "not_configured";
}

export function stateLabel(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "trouble":
      return "Needs attention";
    case "unavailable":
      return "Unavailable";
    default:
      return "Not configured";
  }
}

export const KIND_LABELS: Record<string, string> = {
  api: "API provider",
  local: "Included",
  "cli-proxy": "CLI proxy",
  git: "Version control",
  doc: "Documentation",
  messaging: "Messaging",
  mcp: "MCP",
  webhook: "Webhook",
  oauth: "OAuth",
  web: "Web",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export const DANGEROUS_TOOLS_LABEL = "May execute arbitrary actions"