import { eq } from "drizzle-orm";
import type { MoxDb } from "./client.js";
import { orgOnboarding } from "./schema/onboarding.js";

/**
 * PostgreSQL onboarding store — the durable authority for mandatory customer
 * onboarding. Progress is written here (never React state) so it survives
 * refresh, logout/login, control-plane restarts and org switches.
 *
 * The control-plane onboarding service owns validation and step semantics;
 * this store only performs honest durable reads/writes scoped to one org.
 */

export type OrgOnboardingStatus = "not_started" | "in_progress" | "completed";

export interface OrgOnboardingRow {
  orgId: string;
  status: OrgOnboardingStatus;
  currentStep: number;
  completedSteps: number[];
  persona: string | null;
  goals: string[];
  displayName: string | null;
  workspaceName: string | null;
  modelSetupChoice: string | null;
  modelProviderId: string | null;
  agentSetupChoice: string | null;
  agentId: string | null;
  infrastructureSetupChoice: string | null;
  serverOrderId: string | null;
  connectionsSetupChoice: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  updatedByUserId: string | null;
}

/** Fields a validated onboarding PATCH may write (never `status`). */
export interface OrgOnboardingFieldPatch {
  persona?: string;
  goals?: string[];
  displayName?: string;
  workspaceName?: string;
  modelSetupChoice?: string;
  modelProviderId?: string;
  agentSetupChoice?: string;
  agentId?: string;
  infrastructureSetupChoice?: string;
  serverOrderId?: string;
  connectionsSetupChoice?: string;
}

export interface OrgOnboardingPatch {
  updatedByUserId?: string | null;
  fields: OrgOnboardingFieldPatch;
  /** Step whose decision was recorded (added to completedSteps). */
  markStepComplete?: number;
  /** Explicit current-step pointer for resume (back/forward navigation). */
  advanceTo?: number;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function mapRow(row: typeof orgOnboarding.$inferSelect): OrgOnboardingRow {
  return {
    orgId: row.orgId,
    status: row.status,
    currentStep: row.currentStep,
    completedSteps: [...(row.completedSteps ?? [])],
    persona: row.persona,
    goals: [...(row.goals ?? [])],
    displayName: row.displayName,
    workspaceName: row.workspaceName,
    modelSetupChoice: row.modelSetupChoice,
    modelProviderId: row.modelProviderId,
    agentSetupChoice: row.agentSetupChoice,
    agentId: row.agentId,
    infrastructureSetupChoice: row.infrastructureSetupChoice,
    serverOrderId: row.serverOrderId,
    connectionsSetupChoice: row.connectionsSetupChoice,
    startedAt: iso(row.startedAt),
    updatedAt: iso(row.updatedAt),
    completedAt: iso(row.completedAt),
    updatedByUserId: row.updatedByUserId,
  };
}

/**
 * The default for an organization with no row yet (e.g. created before this
 * table existed but after the backfill, or mid-signup). Reads NEVER create a
 * row: only signup (not_started) and real PATCH progress do.
 */
export function defaultOnboardingRow(orgId: string): OrgOnboardingRow {
  return {
    orgId,
    status: "not_started",
    currentStep: 1,
    completedSteps: [],
    persona: null,
    goals: [],
    displayName: null,
    workspaceName: null,
    modelSetupChoice: null,
    modelProviderId: null,
    agentSetupChoice: null,
    agentId: null,
    infrastructureSetupChoice: null,
    serverOrderId: null,
    connectionsSetupChoice: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    updatedByUserId: null,
  };
}

export class PgOnboardingStore {
  constructor(private readonly db: MoxDb) {}

  async get(orgId: string): Promise<OrgOnboardingRow | undefined> {
    const rows = await this.db.select().from(orgOnboarding).where(eq(orgOnboarding.orgId, orgId)).limit(1);
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async getOrDefault(orgId: string): Promise<OrgOnboardingRow> {
    return (await this.get(orgId)) ?? defaultOnboardingRow(orgId);
  }

  /** Signup authority: new customer workspaces start as not_started. */
  async ensureNotStarted(orgId: string): Promise<void> {
    await this.db
      .insert(orgOnboarding)
      .values({ orgId, status: "not_started" })
      .onConflictDoNothing({ target: orgOnboarding.orgId });
  }

  /**
   * Applies a validated progress patch transactionally. A missing row is
   * created (not_started → in_progress) so progress can never be lost for
   * workspaces created before the signup insert existed. `status` is only
   * advanced to in_progress here — completion is a separate authority.
   */
  async applyPatch(orgId: string, patch: OrgOnboardingPatch): Promise<OrgOnboardingRow> {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      let existing = (
        await tx.select().from(orgOnboarding).where(eq(orgOnboarding.orgId, orgId)).for("update").limit(1)
      )[0];
      if (!existing) {
        const completedSteps = patch.markStepComplete ? [patch.markStepComplete] : [];
        const inserted = await tx
          .insert(orgOnboarding)
          .values({
            orgId,
            status: "in_progress",
            currentStep: patch.advanceTo ?? 1,
            completedSteps,
            startedAt: now,
            updatedAt: now,
            updatedByUserId: patch.updatedByUserId ?? null,
            ...patch.fields,
          })
          .onConflictDoNothing({ target: orgOnboarding.orgId })
          .returning();
        const created = inserted[0];
        if (created) return mapRow(created);
        const raced = (
          await tx.select().from(orgOnboarding).where(eq(orgOnboarding.orgId, orgId)).for("update").limit(1)
        )[0];
        if (!raced) throw new Error(`onboarding row for org ${orgId} could not be created`);
        existing = raced;
      }
      const mergedSteps =
        patch.markStepComplete && !existing.completedSteps.includes(patch.markStepComplete)
          ? [...existing.completedSteps, patch.markStepComplete].sort((a, b) => a - b)
          : [...existing.completedSteps];
      const updated = await tx
        .update(orgOnboarding)
        .set({
          status: existing.status === "completed" ? "completed" : "in_progress",
          currentStep: patch.advanceTo ?? existing.currentStep,
          completedSteps: mergedSteps,
          startedAt: existing.startedAt ?? now,
          updatedAt: now,
          updatedByUserId: patch.updatedByUserId ?? existing.updatedByUserId,
          ...patch.fields,
        })
        .where(eq(orgOnboarding.orgId, orgId))
        .returning();
      const row = updated[0];
      if (!row) throw new Error(`onboarding row for org ${orgId} disappeared during patch`);
      return mapRow(row);
    });
  }

  /**
   * Completion authority. Idempotent: completing an already-completed org is
   * a no-op that returns the current row. Gating (all required decision steps
   * recorded) is enforced by the onboarding service BEFORE calling this.
   */
  async complete(orgId: string, updatedByUserId: string | null): Promise<OrgOnboardingRow> {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const existing = (
        await tx.select().from(orgOnboarding).where(eq(orgOnboarding.orgId, orgId)).for("update").limit(1)
      )[0];
      if (!existing) throw new Error(`onboarding row for org ${orgId} does not exist`);
      if (existing.status === "completed") return mapRow(existing);
      const allSteps = Array.from(new Set([...existing.completedSteps, 1, 2, 3, 4, 5, 6])).sort((a, b) => a - b);
      const updated = await tx
        .update(orgOnboarding)
        .set({
          status: "completed",
          currentStep: 6,
          completedSteps: allSteps,
          startedAt: existing.startedAt ?? now,
          completedAt: existing.completedAt ?? now,
          updatedAt: now,
          updatedByUserId: updatedByUserId ?? existing.updatedByUserId,
        })
        .where(eq(orgOnboarding.orgId, orgId))
        .returning();
      const row = updated[0];
      if (!row) throw new Error(`onboarding row for org ${orgId} disappeared during completion`);
      return mapRow(row);
    });
  }
}
