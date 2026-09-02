import { describe, expect, it } from "vitest";
import {
  ONBOARDING_REVIEW_BADGE,
  deriveOnboardingReview,
  type OnboardingReviewInputs,
} from "../src/domain/onboarding.js";
import type { OnboardingState, ServerSummary } from "../src/api/types.js";

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    orgId: "org_1",
    status: "in_progress",
    currentStep: 6,
    completedSteps: [1, 2, 3, 4, 5],
    persona: "founder",
    goals: ["build-ai-agents"],
    displayName: "Ada",
    workspaceName: "Ada Robotics",
    modelSetupChoice: null,
    modelProviderId: null,
    agentSetupChoice: null,
    agentId: null,
    infrastructureSetupChoice: null,
    serverOrderId: null,
    connectionsSetupChoice: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    updatedByUserId: "usr_1",
    missingRequiredSteps: [6],
    ...overrides,
  };
}

function inputs(overrides: Partial<OnboardingReviewInputs> & { onboarding?: OnboardingState | null }): OnboardingReviewInputs {
  return {
    onboarding: state(),
    models: [],
    modelConnections: [],
    agentCount: 0,
    servers: [],
    integrations: [],
    channels: [],
    apiTokens: [],
    includedServerCount: null,
    ...overrides,
  };
}

function row(rows: ReturnType<typeof deriveOnboardingReview>, key: string) {
  const found = rows.find((r) => r.key === key);
  if (!found) throw new Error(`missing review row ${key}`);
  return found;
}

describe("onboarding final review derives REAL resource state", () => {
  it("workspace and goals come from the recorded persona/goals", () => {
    const rows = deriveOnboardingReview(inputs({}));
    expect(row(rows, "workspace")).toMatchObject({ status: "complete" });
    expect(row(rows, "goals")).toMatchObject({ status: "complete", detail: "1 selected" });
  });

  it("model: connected means a REALLY available model or connection — never a choice alone", () => {
    const connected = deriveOnboardingReview(inputs({ models: [{ modelId: "m", providerId: "mox", displayName: "M", byok: false, available: true }] }));
    expect(row(connected, "model")).toMatchObject({ status: "complete", detail: "Connected" });

    const deferredOnly = deriveOnboardingReview(inputs({ onboarding: state({ modelSetupChoice: "deferred" }) }));
    expect(row(deferredOnly, "model")).toMatchObject({ status: "deferred" });
    // Deferred is NOT a success state.
    expect(ONBOARDING_REVIEW_BADGE.deferred.tone).not.toBe("good");

    const attention = deriveOnboardingReview(inputs({ onboarding: state({ modelSetupChoice: "own_provider", modelProviderId: "openai" }) }));
    expect(row(attention, "model")).toMatchObject({ status: "attention" });

    const pending = deriveOnboardingReview(inputs({ onboarding: state({ modelSetupChoice: null }) }));
    expect(row(pending, "model")).toMatchObject({ status: "pending" });
  });

  it("agent: created and deferred stay distinct", () => {
    const created = deriveOnboardingReview(inputs({ agentCount: 1 }));
    expect(row(created, "agent")).toMatchObject({ status: "complete", detail: "Created" });

    const recordedCreated = deriveOnboardingReview(inputs({ onboarding: state({ agentSetupChoice: "created", agentId: "agt_1" }) }));
    expect(row(recordedCreated, "agent")).toMatchObject({ status: "complete" });

    const deferred = deriveOnboardingReview(inputs({ onboarding: state({ agentSetupChoice: "deferred" }) }));
    expect(row(deferred, "agent")).toMatchObject({ status: "deferred", detail: "Deferred — create one from the dashboard" });
  });

  it("infrastructure: running / provisioning / error / deferred / unavailable are distinct and truthful", () => {
    const running = deriveOnboardingReview(inputs({ servers: [serverRow("running")] }));
    expect(row(running, "infrastructure")).toMatchObject({ status: "complete", detail: "Running" });

    const provisioning = deriveOnboardingReview(inputs({ servers: [serverRow("provisioning")] }));
    expect(row(provisioning, "infrastructure")).toMatchObject({ status: "pending", detail: "Provisioning" });
    // Provisioning is not green "Running" either.
    expect(row(provisioning, "infrastructure").status).not.toBe("complete");

    const errored = deriveOnboardingReview(inputs({ servers: [serverRow("error")] }));
    expect(row(errored, "infrastructure")).toMatchObject({ status: "attention" });

    const deferred = deriveOnboardingReview(inputs({ onboarding: state({ infrastructureSetupChoice: "deferred" }) }));
    expect(row(deferred, "infrastructure")).toMatchObject({ status: "deferred" });

    const unavailable = deriveOnboardingReview(inputs({ includedServerCount: 0 }));
    expect(row(unavailable, "infrastructure")).toMatchObject({ status: "unavailable", detail: "Not included in the current plan" });

    const provisionedButMissing = deriveOnboardingReview(inputs({ onboarding: state({ infrastructureSetupChoice: "provisioned", serverOrderId: "ord_x" }) }));
    expect(row(provisionedButMissing, "infrastructure")).toMatchObject({ status: "attention" });
  });

  it("connections: real configured counts, never fake success", () => {
    const configured = deriveOnboardingReview(inputs({
      integrations: [integrationRow(true)],
      channels: [channelRow(true)],
      apiTokens: [tokenRow(false)],
    }));
    expect(row(configured, "connections")).toMatchObject({ status: "complete", detail: "3 configured" });

    const deferred = deriveOnboardingReview(inputs({ onboarding: state({ connectionsSetupChoice: "deferred" }) }));
    expect(row(deferred, "connections")).toMatchObject({ status: "deferred" });

    const none = deriveOnboardingReview(inputs({}));
    expect(row(none, "connections")).toMatchObject({ status: "pending" });
  });
});

function serverRow(state: string) {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    serverId: "srv_1",
    orderId: "ord_1",
    displayName: "ws-01",
    kind: "customer-vps" as const,
    computeClass: "COMPUTE_SMALL",
    region: "eu-central",
    state: state as ServerSummary["state"],
    agentsRunning: null,
    cpuPct: null,
    memPct: null,
    createdAt: at,
    updatedAt: at,
  };
}

function integrationRow(connected: boolean) {
  return {
    integrationId: "github",
    displayName: "GitHub",
    kind: "app",
    connectionId: null,
    status: connected ? "connected" : "unconfigured",
    credentialConfigured: connected,
    connected,
    requiresRuntimeSession: false,
    dangerous: false,
    tools: [],
    configFields: [],
  };
}

function channelRow(connected: boolean) {
  return {
    channelId: "telegram",
    displayName: "Telegram",
    kind: "chat",
    setupInstructions: "",
    prerequisites: null,
    secretKeys: ["botToken"],
    connectionId: null,
    status: connected ? "connected" : "unconfigured",
    credentialConfigured: connected,
    connected,
    boundAgentId: null,
    boundAgentName: null,
  };
}

function tokenRow(revoked: boolean) {
  return {
    tokenId: "tok_1",
    name: "CI",
    scopes: ["agents"],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    revoked,
  };
}
