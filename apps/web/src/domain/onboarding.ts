import type {
  ApiTokenRow,
  ChannelCatalogRow,
  IntegrationCatalogRow,
  ModelConnectionRow,
  ModelOption,
  OnboardingPersona,
  OnboardingState,
  ServerSummary,
} from "../api/types.js";

/**
 * Pure onboarding domain logic: routing decisions, post-auth destinations and
 * the final review derivation. Everything here is derived from REAL resource
 * state (models, agents, servers, connections) — never from onboarding
 * bookkeeping — and every function is UI-framework free so the routing matrix
 * and deferred/completed semantics can be tested directly.
 */

export const ONBOARDING_ROUTE = "/onboarding";

export const ONBOARDING_TOTAL_STEPS = 6;

export const ONBOARDING_STEP_META: Record<number, { title: string; kicker: string }> = {
  1: { kicker: "Welcome", title: "Build your Mox workspace" },
  2: { kicker: "Goals", title: "What do you want to do with Mox?" },
  3: { kicker: "AI models", title: "Set up your model access" },
  4: { kicker: "First agent", title: "Create your first agent" },
  5: { kicker: "Infrastructure", title: "Dedicated infrastructure" },
  6: { kicker: "Connections", title: "Connections and readiness" },
};

export const ONBOARDING_PERSONAS: Array<{ id: OnboardingPersona; label: string; hint: string }> = [
  { id: "founder", label: "Founder / business owner", hint: "Automate work without a dev team" },
  { id: "developer", label: "Developer", hint: "Author agents with full control" },
  { id: "agency", label: "Agency", hint: "Deliver agent projects for clients" },
  { id: "operations", label: "Operations / team", hint: "Run internal workflows with my team" },
  { id: "other", label: "Other", hint: "Something else entirely" },
];

export const ONBOARDING_GOALS: Array<{ id: string; label: string; hint: string }> = [
  { id: "build-ai-agents", label: "Build AI agents", hint: "Author and publish agents" },
  { id: "automate-business-workflows", label: "Automate business workflows", hint: "Recurring operational work" },
  { id: "deploy-autonomous-agents", label: "Deploy autonomous agents", hint: "Long-running unattended runs" },
  { id: "connect-messaging-channels", label: "Connect messaging channels", hint: "Telegram, Slack, Discord…" },
  { id: "connect-business-apps", label: "Connect business apps / integrations", hint: "GitHub, Notion, n8n…" },
  { id: "use-own-ai-provider", label: "Use my own AI provider / API keys", hint: "Bring your own key (BYOK)" },
  { id: "dedicated-infrastructure", label: "Run agents on dedicated infrastructure", hint: "Your own VPS compute" },
  { id: "developer-cli-workflows", label: "Developer / CLI workflows", hint: "API tokens and the CLI" },
];

export const ONBOARDING_PERMISSION_PRESETS = [
  { id: "safe", label: "Safe", hint: "Approve spend, external sends and deployments" },
  { id: "balanced", label: "Balanced", hint: "Approve spend and external sends" },
  { id: "full", label: "Full", hint: "No approval prompts" },
] as const;

/** Product routes an incomplete workspace may NOT reach (guarded). */
export const CUSTOMER_PRODUCT_ROUTES = [
  "/dashboard",
  "/agents",
  "/rooms",
  "/servers",
  "/deployments",
  "/models",
  "/integrations",
  "/channels",
  "/usage",
  "/billing",
  "/backups",
  "/settings",
] as const;

export type CustomerOnboardingGuard =
  | { kind: "view-onboarding" }
  | { kind: "redirect"; to: string }
  | { kind: "allow" };

/**
 * The routing matrix for an authenticated (or unknown) customer surface visit.
 * `onboarding === null` means the durable state has not loaded (or could not
 * be loaded) — the router fails OPEN to avoid trapping users during an
 * availability incident; /onboarding itself always re-reads the authority.
 */
export function resolveCustomerOnboardingRouting(input: {
  path: string;
  onboarding: OnboardingState | null;
}): CustomerOnboardingGuard {
  const status = input.onboarding?.status ?? null;
  if (input.path === ONBOARDING_ROUTE) {
    // Completed customers never re-enter the wizard.
    if (status === "completed") return { kind: "redirect", to: "/dashboard" };
    return { kind: "view-onboarding" };
  }
  if (status === "not_started" || status === "in_progress") {
    if (input.path === "/" || (CUSTOMER_PRODUCT_ROUTES as readonly string[]).includes(input.path)) {
      return { kind: "redirect", to: ONBOARDING_ROUTE };
    }
  }
  return { kind: "allow" };
}

/**
 * Where to go after successful signup/login. Signup always lands on
 * onboarding (a fresh workspace starts not_started); login inspects the
 * active org's durable onboarding state.
 */
export function postAuthDestination(input: {
  signedUp: boolean;
  onboarding: OnboardingState | null;
  returnTo: string | null;
}): string {
  const status = input.onboarding?.status ?? null;
  if (status === "not_started" || status === "in_progress") return ONBOARDING_ROUTE;
  if (input.signedUp) return ONBOARDING_ROUTE;
  const returnTo = input.returnTo;
  if (returnTo && returnTo !== ONBOARDING_ROUTE && returnTo !== "/") return returnTo;
  return "/dashboard";
}

export function isOnboardingIncomplete(onboarding: OnboardingState | null | undefined): boolean {
  return onboarding?.status === "not_started" || onboarding?.status === "in_progress";
}

export function isOnboardingComplete(onboarding: OnboardingState | null | undefined): boolean {
  return onboarding?.status === "completed";
}

// ---- Final review derivation (real resource state only) ----------------------

export type OnboardingReviewStatus = "complete" | "deferred" | "attention" | "unavailable" | "pending";

export interface OnboardingReviewRow {
  key: "workspace" | "goals" | "model" | "agent" | "infrastructure" | "connections";
  label: string;
  status: OnboardingReviewStatus;
  detail: string;
}

export interface OnboardingReviewInputs {
  onboarding: OnboardingState | null;
  models: ModelOption[];
  modelConnections: ModelConnectionRow[];
  agentCount: number;
  servers: ServerSummary[];
  integrations: IntegrationCatalogRow[];
  channels: ChannelCatalogRow[];
  apiTokens: ApiTokenRow[];
  includedServerCount: number | null;
}

/**
 * The truthful final review. Deferred choices show as "Deferred" (never a
 * success checkmark); unavailable external services show as "Unavailable"
 * with the honest reason.
 */
export function deriveOnboardingReview(inputs: OnboardingReviewInputs): OnboardingReviewRow[] {
  const obd = inputs.onboarding;
  const rows: OnboardingReviewRow[] = [];

  const personaRecorded = Boolean(obd?.persona);
  rows.push({
    key: "workspace",
    label: "Workspace",
    status: personaRecorded ? "complete" : "pending",
    detail: obd?.workspaceName ?? "Workspace profile",
  });

  const goalCount = obd?.goals.length ?? 0;
  rows.push({
    key: "goals",
    label: "Goals",
    status: obd ? "complete" : "pending",
    detail: goalCount > 0 ? `${goalCount} selected` : "No goals selected",
  });

  const modelConnected =
    inputs.models.some((m) => m.available) || inputs.modelConnections.some((c) => c.connected);
  if (modelConnected) {
    rows.push({ key: "model", label: "AI model", status: "complete", detail: "Connected" });
  } else if (obd?.modelSetupChoice === "deferred") {
    rows.push({ key: "model", label: "AI model", status: "deferred", detail: "Deferred — no provider connected yet" });
  } else if (obd?.modelSetupChoice === "own_provider" || obd?.modelSetupChoice === "mox_managed") {
    rows.push({ key: "model", label: "AI model", status: "attention", detail: "Choice recorded, but no provider is connected" });
  } else {
    rows.push({ key: "model", label: "AI model", status: "pending", detail: "No decision recorded" });
  }

  const agentCreated = (obd?.agentSetupChoice === "created" && Boolean(obd.agentId)) || inputs.agentCount > 0;
  if (agentCreated) {
    rows.push({ key: "agent", label: "First agent", status: "complete", detail: "Created" });
  } else if (obd?.agentSetupChoice === "deferred") {
    rows.push({ key: "agent", label: "First agent", status: "deferred", detail: "Deferred — create one from the dashboard" });
  } else {
    rows.push({ key: "agent", label: "First agent", status: "pending", detail: "No decision recorded" });
  }

  const running = inputs.servers.some((s) => s.state === "running");
  const provisioning = inputs.servers.some((s) => ["requested", "provisioning", "resizing"].includes(s.state));
  const errored = inputs.servers.some((s) => s.state === "error");
  if (running) {
    rows.push({ key: "infrastructure", label: "Infrastructure", status: "complete", detail: "Running" });
  } else if (provisioning) {
    rows.push({ key: "infrastructure", label: "Infrastructure", status: "pending", detail: "Provisioning" });
  } else if (errored) {
    rows.push({ key: "infrastructure", label: "Infrastructure", status: "attention", detail: "A server order is in error — see Servers" });
  } else if (obd?.infrastructureSetupChoice === "deferred") {
    rows.push({ key: "infrastructure", label: "Infrastructure", status: "deferred", detail: "Deferred — provision later from Servers" });
  } else if (inputs.includedServerCount === 0) {
    rows.push({ key: "infrastructure", label: "Infrastructure", status: "unavailable", detail: "Not included in the current plan" });
  } else if (inputs.includedServerCount !== null && inputs.includedServerCount < 1) {
    rows.push({ key: "infrastructure", label: "Infrastructure", status: "unavailable", detail: "Not included in the current plan" });
  } else if (obd?.infrastructureSetupChoice === "provisioned") {
    rows.push({ key: "infrastructure", label: "Infrastructure", status: "attention", detail: "Choice recorded, but no server order found" });
  } else {
    rows.push({ key: "infrastructure", label: "Infrastructure", status: "pending", detail: "No decision recorded" });
  }

  const configuredConnections =
    inputs.integrations.filter((i) => i.connected).length +
    inputs.channels.filter((c) => c.connected).length +
    inputs.apiTokens.filter((t) => !t.revoked).length;
  if (configuredConnections > 0) {
    rows.push({
      key: "connections",
      label: "Connections",
      status: "complete",
      detail: `${configuredConnections} configured`,
    });
  } else if (obd?.connectionsSetupChoice === "deferred") {
    rows.push({ key: "connections", label: "Connections", status: "deferred", detail: "Deferred — connect apps any time" });
  } else {
    rows.push({ key: "connections", label: "Connections", status: "pending", detail: "No decision recorded" });
  }

  return rows;
}

export const ONBOARDING_REVIEW_BADGE: Record<OnboardingReviewStatus, { tone: "good" | "warn" | "bad" | "neutral" | "accent"; label: string }> = {
  complete: { tone: "good", label: "Complete" },
  deferred: { tone: "neutral", label: "Deferred" },
  attention: { tone: "warn", label: "Needs attention" },
  unavailable: { tone: "bad", label: "Unavailable" },
  pending: { tone: "neutral", label: "Pending" },
};
