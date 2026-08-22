/**
 * CLI / subscription engine connectors (Prompt 07).
 *
 * A SEPARATE connector category from API providers. Rules enforced here:
 * - official device/login flows only — browser-cookie scraping is forbidden
 *   by design (no code path accepts cookies);
 * - hosted Mox use is feature-flagged per provider/commercial approval;
 * - every engine carries an explicit support tier, and the user's API route
 *   always remains independently available.
 */

export type CliEngineId = "codex" | "claude-code" | "gemini-cli" | "grok-cli";
export type CliSupportTier = "OFFICIAL" | "API_ONLY" | "EXPERIMENTAL" | "UNSUPPORTED";

export interface CliEngineDescriptor {
  engineId: CliEngineId;
  displayName: string;
  vendor: string;
  supportTier: CliSupportTier;
  authMode: "official-device-login" | "none";
  /** Hosted (Mox cloud) usage requires this flag to be enabled commercially. */
  hostedFeatureFlag: string;
  /** The same vendor's plain API route that remains available regardless. */
  apiFallbackProviderId: string;
}

export const CLI_ENGINES: ReadonlyArray<CliEngineDescriptor> = [
  {
    engineId: "codex",
    displayName: "Codex CLI",
    vendor: "OpenAI",
    supportTier: "OFFICIAL",
    authMode: "official-device-login",
    hostedFeatureFlag: "cli.codex.hosted",
    apiFallbackProviderId: "p_openai",
  },
  {
    engineId: "claude-code",
    displayName: "Claude Code",
    vendor: "Anthropic",
    supportTier: "API_ONLY",
    authMode: "official-device-login",
    hostedFeatureFlag: "cli.claude-code.hosted",
    apiFallbackProviderId: "p_anthropic",
  },
  {
    engineId: "gemini-cli",
    displayName: "Gemini CLI",
    vendor: "Google",
    supportTier: "EXPERIMENTAL",
    authMode: "official-device-login",
    hostedFeatureFlag: "cli.gemini-cli.hosted",
    apiFallbackProviderId: "p_google",
  },
  {
    engineId: "grok-cli",
    displayName: "Grok CLI",
    vendor: "xAI",
    supportTier: "UNSUPPORTED",
    authMode: "none",
    hostedFeatureFlag: "cli.grok-cli.hosted",
    apiFallbackProviderId: "p_xai",
  },
] as const;

export interface CliConnectionState {
  engineId: CliEngineId;
  connected: boolean;
  state: "not-connected" | "awaiting-device-authorization" | "connected" | "blocked-by-flag" | "unsupported";
  reason?: string;
}

export interface CliFeatureFlags {
  isEnabled(flag: string): boolean;
}

export class CliEngineConnector {
  constructor(private readonly flags: CliFeatureFlags) {}

  descriptor(engineId: CliEngineId): CliEngineDescriptor {
    const d = CLI_ENGINES.find((e) => e.engineId === engineId);
    if (!d) throw new Error(`unknown cli engine: ${engineId}`);
    return d;
  }

  list(): CliEngineDescriptor[] {
    return [...CLI_ENGINES];
  }

  /**
   * Begin an OFFICIAL device login. This returns a pending state — it never
   * accepts pasted cookies/tokens scraped from a browser session.
   */
  async beginDeviceLogin(engineId: CliEngineId): Promise<CliConnectionState> {
    const d = this.descriptor(engineId);
    if (d.supportTier === "UNSUPPORTED") {
      return { engineId, connected: false, state: "unsupported", reason: `${d.displayName} has no supported subscription flow on Mox; use ${d.apiFallbackProviderId} API keys instead` };
    }
    if (!this.flags.isEnabled(d.hostedFeatureFlag)) {
      return { engineId, connected: false, state: "blocked-by-flag", reason: `hosted usage of ${d.displayName} requires flag ${d.hostedFeatureFlag}` };
    }
    // Real device-flow handshake is executed by the Mox Node agent process;
    // the gateway only tracks state honestly here.
    return { engineId, connected: false, state: "awaiting-device-authorization" };
  }

  completeDeviceLogin(engineId: CliEngineId, authorized: boolean): CliConnectionState {
    const d = this.descriptor(engineId);
    if (!authorized) {
      return { engineId, connected: false, state: "not-connected", reason: "device authorization denied or expired" };
    }
    return { engineId, connected: true, state: "connected" };
  }
}
