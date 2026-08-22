import type { ComputerAction } from "@mox/contracts";

/**
 * Computer provider abstraction (Prompt 04). A provider advertises its
 * capabilities and executes actions inside its own isolation boundary.
 * Playwright/Chromium is the default; OpenMaus CUA/local/cloud/device
 * providers implement the same surface later (capability hooks only).
 */

export type ComputerCapability =
  | "browser"
  | "shell"
  | "filesystem"
  | "screencast"
  | "desktop-cua"
  | "mobile-device"
  | "human-takeover"
  | "profiles-cookies"
  | "aria-snapshots";

export interface ProviderConstraints {
  /** Deployment regions this provider can run in. */
  regions: readonly string[];
  /** Runtime kinds this provider supports. */
  runtimes: ReadonlyArray<"mox-cloud" | "customer-vps" | "local-device" | "sandbox">;
}

export interface ComputerActionOutcome {
  ok: boolean;
  output: Record<string, unknown>;
  /** Server-resolved facts (e.g. final URL, snapshot ref) for audit rows. */
  observed?: Record<string, unknown>;
}

export interface ComputerSessionInfo {
  sessionId: string;
  orgId: string;
  agentId: string;
  state: "pending" | "active" | "paused" | "closed";
  /** Human currently has control (takeover active). */
  humanControl: boolean;
  startedAt: string;
}

/**
 * A resolved action: the gateway hands the provider a fully-decided action
 * with server-side context already attached. Providers never see policy.
 */
export interface ResolvedAction {
  action: ComputerAction;
  effectClass: EffectClass;
  /** Server-fetched page facts for click/type/key decisions. */
  page?: { url: string; host: string };
  element?: { ref: string; role: string; name: string };
  key?: string;
}

export type EffectClass =
  | "activate"
  | "type"
  | "navigate"
  | "read"
  | "write_file"
  | "read_file"
  | "list_files"
  | "shell"
  | "screencast"
  | "takeover";

export interface ComputerProvider {
  readonly providerId: string;
  readonly displayName: string;
  capabilities(): readonly ComputerCapability[];
  constraints(): ProviderConstraints;
  /** Create an isolated session (one per agent/session; never shared). */
  openSession(input: { orgId: string; agentId: string; sessionId: string }): Promise<ComputerSessionInfo>;
  getSession(sessionId: string): Promise<ComputerSessionInfo | undefined>;
  /** Execute one action. Called by the gateway AFTER policy + audit. */
  execute(sessionId: string, resolved: ResolvedAction): Promise<ComputerActionOutcome>;
  /** Human takeover: a person drives; the agent pauses. */
  startTakeover(sessionId: string, takenBy: string): Promise<ComputerSessionInfo>;
  endTakeover(sessionId: string): Promise<ComputerSessionInfo>;
  /** Screencast metadata (never secret-bearing; scrubbed upstream). */
  screencastInfo(sessionId: string): Promise<Record<string, unknown>>;
  closeSession(sessionId: string): Promise<void>;
  checkHealth(): Promise<{ healthy: boolean; reason?: string }>;
}

/** Classify a canonical ComputerAction into its policy effect class. */
export function effectClassOf(action: ComputerAction): EffectClass {
  switch (action.kind) {
    case "click":
      return "activate";
    case "type":
    case "key":
      return "type";
    case "navigate":
      return "navigate";
    case "screenshot":
      return "read";
    case "scroll":
      return "read";
    case "execute":
      return "shell";
    case "wait":
      return "read";
    default:
      return "activate";
  }
}
