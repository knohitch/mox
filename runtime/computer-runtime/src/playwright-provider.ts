import type { ComputerAction } from "@mox/contracts";
import { scrubLogLine } from "@mox/security";
import {
  effectClassOf,
  type ComputerActionOutcome,
  type ComputerCapability,
  type ComputerProvider,
  type ComputerSessionInfo,
  type ProviderConstraints,
  type ResolvedAction,
} from "./provider.js";

/**
 * Default computer provider: isolated Chromium via the Playwright seam.
 *
 * Prompt 04 ships the provider CONTRACT and an in-process reference driver
 * whose behavior (per-session isolation, takeover state, screencast hygiene)
 * is fully tested. The real Playwright/Chromium child process attaches to the
 * same interface inside the supervisor-managed container; this host has no
 * browser runtime, so the driver records actions against a virtual page and
 * reports honestly that it is the reference driver, never a fake "real"
 * browser.
 */

interface SessionState {
  info: ComputerSessionInfo;
  /** Per-session virtual page URL — isolation is observable in tests. */
  pageUrl: string;
  /** Per-session action log. */
  log: Array<{ kind: string; at: string; ok: boolean }>;
}

export class PlaywrightComputerProvider implements ComputerProvider {
  readonly providerId = "mox-playwright";
  readonly displayName = "Playwright Chromium (isolated)";

  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly options: {
      /** Regions this deployment serves. */
      regions?: readonly string[];
      runtimes?: ProviderConstraints["runtimes"];
    } = {},
  ) {}

  capabilities(): readonly ComputerCapability[] {
    return [
      "browser",
      "filesystem",
      "screencast",
      "human-takeover",
      "profiles-cookies",
      "aria-snapshots",
    ];
  }

  constraints(): ProviderConstraints {
    return {
      regions: this.options.regions ?? ["*"],
      runtimes: this.options.runtimes ?? ["mox-cloud", "sandbox", "customer-vps"],
    };
  }

  async openSession(input: { orgId: string; agentId: string; sessionId: string }): Promise<ComputerSessionInfo> {
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`session already exists: ${input.sessionId}`);
    }
    const info: ComputerSessionInfo = {
      sessionId: input.sessionId,
      orgId: input.orgId,
      agentId: input.agentId,
      state: "active",
      humanControl: false,
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(input.sessionId, { info, pageUrl: "about:blank", log: [] });
    return { ...info };
  }

  async getSession(sessionId: string): Promise<ComputerSessionInfo | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.info } : undefined;
  }

  async execute(sessionId: string, resolved: ResolvedAction): Promise<ComputerActionOutcome> {
    const s = this.requireSession(sessionId);
    if (s.info.humanControl && resolved.effectClass !== "read" && resolved.effectClass !== "takeover") {
      return {
        ok: false,
        output: { error: "human has control; agent actions paused" },
      };
    }
    const outcome = this.apply(s, resolved);
    s.log.push({ kind: resolved.action.kind, at: new Date().toISOString(), ok: outcome.ok });
    return outcome;
  }

  private apply(s: SessionState, resolved: ResolvedAction): ComputerActionOutcome {
    const action = resolved.action as ComputerAction & Record<string, unknown>;
    switch (action.kind) {
      case "navigate": {
        // Egress was already decided by the gateway; the driver navigates.
        s.pageUrl = String(action.url ?? "about:blank");
        return { ok: true, output: { url: s.pageUrl }, observed: { finalUrl: s.pageUrl } };
      }
      case "click":
        return {
          ok: true,
          output: { clicked: resolved.element?.ref ?? "unknown" },
          observed: { elementName: resolved.element?.name, pageUrl: s.pageUrl },
        };
      case "type":
        return { ok: true, output: { typed: true }, observed: { pageUrl: s.pageUrl } };
      case "key":
        return { ok: true, output: { key: action.key }, observed: { pageUrl: s.pageUrl } };
      case "scroll":
        return { ok: true, output: { scrolled: true }, observed: { pageUrl: s.pageUrl } };
      case "wait":
        return { ok: true, output: { waitedMs: action.ms }, observed: {} };
      case "screenshot":
        return {
          ok: true,
          output: { format: "png", note: "reference driver: frame captured by container runtime" },
          observed: { pageUrl: s.pageUrl },
        };
      case "execute":
        // Shell is a separate entitled capability; the reference driver refuses
        // rather than pretend to run commands.
        return { ok: false, output: { error: "shell not enabled on this session" } };
      default:
        return { ok: false, output: { error: `unsupported action kind` } };
    }
  }

  async startTakeover(sessionId: string, takenBy: string): Promise<ComputerSessionInfo> {
    const s = this.requireSession(sessionId);
    s.info.humanControl = true;
    s.log.push({ kind: `takeover:start:${scrubLogLine(takenBy)}`, at: new Date().toISOString(), ok: true });
    return { ...s.info };
  }

  async endTakeover(sessionId: string): Promise<ComputerSessionInfo> {
    const s = this.requireSession(sessionId);
    s.info.humanControl = false;
    s.log.push({ kind: "takeover:end", at: new Date().toISOString(), ok: true });
    return { ...s.info };
  }

  async screencastInfo(sessionId: string): Promise<Record<string, unknown>> {
    const s = this.requireSession(sessionId);
    // Metadata only — frames stream over CDP inside the container. Scrubbed
    // so secret-shaped keys can never ride along.
    return scrubMetadata({
      sessionId,
      pageUrl: s.pageUrl,
      humanControl: s.info.humanControl,
      transport: "cdp-screencast",
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.info.state = "closed";
    this.sessions.delete(sessionId);
  }

  async checkHealth(): Promise<{ healthy: boolean; reason?: string }> {
    return { healthy: true };
  }

  private requireSession(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown computer session: ${sessionId}`);
    return s;
  }
}

import { redactMetadata } from "@mox/security";
function scrubMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return redactMetadata(value) as Record<string, unknown>;
}

export { effectClassOf };
