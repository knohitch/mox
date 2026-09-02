/**
 * Mandatory customer onboarding — authoritative step/decision semantics.
 *
 * The durable state lives in `org_onboarding` (PgOnboardingStore). This module
 * owns the PART the database cannot express:
 * - which fields belong to which step (a PATCH may only write its own step);
 * - which values are valid (typed enums, bounded strings, goal allow-list);
 * - when a step's decision counts as "recorded";
 * - when completion is allowed (every required decision step recorded).
 *
 * A deferred external setup (provider, agent, server, connection) is a real,
 * recorded onboarding decision — it never marks the underlying feature as
 * configured, and it never fabricates success.
 */

import { httpError } from "./http.js";
import type { OrgOnboardingFieldPatch, OrgOnboardingRow } from "@mox/database";

export const ONBOARDING_TOTAL_STEPS = 6;

export const ONBOARDING_PERSONAS = [
  "founder",
  "developer",
  "agency",
  "operations",
  "other",
] as const;
export type OnboardingPersona = (typeof ONBOARDING_PERSONAS)[number];

/** Goals personalize UX only — they never grant entitlements or capabilities. */
export const ONBOARDING_GOALS = [
  "build-ai-agents",
  "automate-business-workflows",
  "deploy-autonomous-agents",
  "connect-messaging-channels",
  "connect-business-apps",
  "use-own-ai-provider",
  "dedicated-infrastructure",
  "developer-cli-workflows",
] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export const MODEL_SETUP_CHOICES = ["mox_managed", "own_provider", "deferred"] as const;
export type ModelSetupChoice = (typeof MODEL_SETUP_CHOICES)[number];

export const AGENT_SETUP_CHOICES = ["created", "deferred"] as const;
export type AgentSetupChoice = (typeof AGENT_SETUP_CHOICES)[number];

export const INFRASTRUCTURE_SETUP_CHOICES = ["provisioned", "deferred"] as const;
export type InfrastructureSetupChoice = (typeof INFRASTRUCTURE_SETUP_CHOICES)[number];

export const CONNECTIONS_SETUP_CHOICES = ["configured", "deferred"] as const;
export type ConnectionsSetupChoice = (typeof CONNECTIONS_SETUP_CHOICES)[number];

/** Fields each step may write — cross-step writes are rejected. */
const STEP_FIELDS: Record<number, readonly (keyof OrgOnboardingFieldPatch)[]> = {
  1: ["persona", "displayName", "workspaceName"],
  2: ["goals"],
  3: ["modelSetupChoice", "modelProviderId"],
  4: ["agentSetupChoice", "agentId"],
  5: ["infrastructureSetupChoice", "serverOrderId"],
  6: ["connectionsSetupChoice"],
};

/** A step counts as recorded only when its required decision fields were sent. */
const STEP_REQUIRED_FIELDS: Record<number, readonly (keyof OrgOnboardingFieldPatch)[]> = {
  1: ["persona"],
  2: ["goals"],
  3: ["modelSetupChoice"],
  4: ["agentSetupChoice"],
  5: ["infrastructureSetupChoice"],
  6: ["connectionsSetupChoice"],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OnboardingPatchCommand {
  step: number;
  /** Explicit current-step pointer for resume navigation (1..6). */
  advanceTo?: number;
  fields: OrgOnboardingFieldPatch;
  /** Step whose decision was recorded by this patch (present when complete). */
  markStepComplete?: number;
}

function fail(message: string, code?: string): never {
  throw httpError(message, 400, code ? { code } : undefined);
}

function asObject(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) fail("a request body is required");
  if (typeof raw !== "object" || Array.isArray(raw)) fail("request body must be an object");
  return raw as Record<string, unknown>;
}

function stringField(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) fail(`${field} must not be empty`);
  if (trimmed.length > max) fail(`${field} must be ${max} characters or less`);
  return trimmed;
}

/** Validates and narrows a raw PATCH body into a step-scoped write command. */
export function validateOnboardingPatch(raw: unknown): OnboardingPatchCommand {
  const body = asObject(raw);
  const step = body.step;
  if (typeof step !== "number" || !Number.isInteger(step) || step < 1 || step > ONBOARDING_TOTAL_STEPS) {
    fail(`step must be an integer between 1 and ${ONBOARDING_TOTAL_STEPS}`);
  }

  let advanceTo: number | undefined;
  if (body.advanceTo !== undefined) {
    if (
      typeof body.advanceTo !== "number" ||
      !Number.isInteger(body.advanceTo) ||
      body.advanceTo < 1 ||
      body.advanceTo > ONBOARDING_TOTAL_STEPS
    ) {
      fail(`advanceTo must be an integer between 1 and ${ONBOARDING_TOTAL_STEPS}`);
    }
    advanceTo = body.advanceTo;
  }

  const allowedFields = STEP_FIELDS[step]!;
  const fields: OrgOnboardingFieldPatch = {};

  if (body.persona !== undefined) {
    if (typeof body.persona !== "string" || !(ONBOARDING_PERSONAS as readonly string[]).includes(body.persona)) {
      fail("persona is not a known onboarding persona", "onboarding_invalid_persona");
    }
    fields.persona = body.persona;
  }
  if (body.displayName !== undefined) fields.displayName = stringField(body.displayName, "displayName", 120);
  if (body.workspaceName !== undefined) {
    fields.workspaceName = stringField(body.workspaceName, "workspaceName", 120);
  }

  if (body.goals !== undefined) {
    if (!Array.isArray(body.goals)) fail("goals must be an array of goal ids");
    const goals = Array.from(new Set(body.goals.map((g) => String(g)))).filter((g) => g.length > 0);
    for (const goal of goals) {
      if (!(ONBOARDING_GOALS as readonly string[]).includes(goal)) {
        fail(`unknown onboarding goal: ${goal}`, "onboarding_invalid_goal");
      }
    }
    if (goals.length > ONBOARDING_GOALS.length) fail("goals contains too many entries");
    fields.goals = goals;
  }

  if (body.modelSetupChoice !== undefined) {
    if (typeof body.modelSetupChoice !== "string" || !(MODEL_SETUP_CHOICES as readonly string[]).includes(body.modelSetupChoice)) {
      fail("modelSetupChoice must be mox_managed, own_provider or deferred", "onboarding_invalid_model_choice");
    }
    fields.modelSetupChoice = body.modelSetupChoice;
    if (body.modelProviderId !== undefined) {
      fields.modelProviderId = stringField(body.modelProviderId, "modelProviderId", 80);
    }
    // Only a REAL provider connection may reference a provider; "configure
    // later" never pretends a provider was connected.
    if (fields.modelSetupChoice !== "own_provider" && fields.modelProviderId !== undefined) {
      fail("modelProviderId may only be recorded with the own_provider choice");
    }
  } else if (body.modelProviderId !== undefined) {
    fail("modelProviderId requires modelSetupChoice");
  }

  if (body.agentSetupChoice !== undefined) {
    if (typeof body.agentSetupChoice !== "string" || !(AGENT_SETUP_CHOICES as readonly string[]).includes(body.agentSetupChoice)) {
      fail("agentSetupChoice must be created or deferred", "onboarding_invalid_agent_choice");
    }
    fields.agentSetupChoice = body.agentSetupChoice;
    if (fields.agentSetupChoice === "created") {
      if (typeof body.agentId !== "string" || !UUID_RE.test(body.agentId)) {
        fail("agentId must be the id of a real created agent");
      }
      fields.agentId = body.agentId;
    }
  } else if (body.agentId !== undefined) {
    fail("agentId requires agentSetupChoice");
  }

  if (body.infrastructureSetupChoice !== undefined) {
    if (
      typeof body.infrastructureSetupChoice !== "string" ||
      !(INFRASTRUCTURE_SETUP_CHOICES as readonly string[]).includes(body.infrastructureSetupChoice)
    ) {
      fail("infrastructureSetupChoice must be provisioned or deferred", "onboarding_invalid_infrastructure_choice");
    }
    fields.infrastructureSetupChoice = body.infrastructureSetupChoice;
    if (fields.infrastructureSetupChoice === "provisioned") {
      if (typeof body.serverOrderId !== "string" || !UUID_RE.test(body.serverOrderId)) {
        fail("serverOrderId must be the id of a real server order");
      }
      fields.serverOrderId = body.serverOrderId;
    }
  } else if (body.serverOrderId !== undefined) {
    fail("serverOrderId requires infrastructureSetupChoice");
  }

  if (body.connectionsSetupChoice !== undefined) {
    if (
      typeof body.connectionsSetupChoice !== "string" ||
      !(CONNECTIONS_SETUP_CHOICES as readonly string[]).includes(body.connectionsSetupChoice)
    ) {
      fail("connectionsSetupChoice must be configured or deferred", "onboarding_invalid_connections_choice");
    }
    fields.connectionsSetupChoice = body.connectionsSetupChoice;
  }

  for (const key of Object.keys(fields) as (keyof OrgOnboardingFieldPatch)[]) {
    if (!allowedFields.includes(key)) {
      fail(`field ${key} belongs to a different onboarding step`, "onboarding_step_field_mismatch");
    }
  }

  const markStepComplete = STEP_REQUIRED_FIELDS[step]!.every((field) => fields[field] !== undefined)
    ? step
    : undefined;
  return { step, advanceTo, fields, markStepComplete };
}

/** Steps whose decision has not been recorded yet. */
export function missingRequiredSteps(row: { completedSteps: number[] }): number[] {
  const missing: number[] = [];
  for (let step = 1; step <= ONBOARDING_TOTAL_STEPS; step += 1) {
    if (row.completedSteps.includes(step)) continue;
    missing.push(step);
  }
  return missing;
}

/** Completion is only allowed once every required decision step is recorded. */
export function assertCompletionAllowed(row: OrgOnboardingRow): void {
  if (row.status === "completed") return;
  const missing = missingRequiredSteps(row);
  if (missing.length > 0) {
    throw httpError(
      `onboarding cannot be completed yet; missing decision steps: ${missing.join(", ")}`,
      409,
      { code: "onboarding_incomplete", reason: missing.join(",") },
    );
  }
}

/** Customer-safe projection of the durable row. Contains no secrets. */
export function projectOnboarding(row: OrgOnboardingRow) {
  return {
    orgId: row.orgId,
    status: row.status,
    currentStep: row.currentStep,
    completedSteps: [...row.completedSteps],
    persona: row.persona,
    goals: [...row.goals],
    displayName: row.displayName,
    workspaceName: row.workspaceName,
    modelSetupChoice: row.modelSetupChoice,
    modelProviderId: row.modelProviderId,
    agentSetupChoice: row.agentSetupChoice,
    agentId: row.agentId,
    infrastructureSetupChoice: row.infrastructureSetupChoice,
    serverOrderId: row.serverOrderId,
    connectionsSetupChoice: row.connectionsSetupChoice,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    updatedByUserId: row.updatedByUserId,
    missingRequiredSteps: missingRequiredSteps(row),
  };
}
