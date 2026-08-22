/**
 * Platform operations service (Prompt 12): abuse workflow with
 * provider-side emergency suspension, and incident lifecycle management.
 */

import { randomUUID } from "node:crypto";
import type { ComputeProvider } from "@mox/compute-providers";
import type {
  AbuseCase,
  AbuseSeverity,
  Incident,
  IncidentKind,
  ServerOwnershipLookup,
  Severity2,
} from "./types.js";
import {
  InMemoryAbuseStore,
  InMemoryIncidentStore,
  type AbuseStore,
  type IncidentStore,
} from "./types.js";

export class PlatformOpsError extends Error {}

function nowIso(): string {
  return new Date().toISOString();
}

export interface PlatformOpsOptions {
  /** Repeat-abuse threshold for flagging accounts. */
  repeatAbuseThreshold?: number;
}

export class PlatformOpsService {
  readonly abuseStore: AbuseStore;
  readonly incidentStore: IncidentStore;
  private readonly providers = new Map<string, ComputeProvider>();
  private readonly ownership?: ServerOwnershipLookup;
  private readonly repeatAbuseThreshold: number;
  readonly flaggedOrgs = new Set<string>();

  constructor(
    options: {
      abuseStore?: AbuseStore;
      incidentStore?: IncidentStore;
      ownership?: ServerOwnershipLookup;
      repeatAbuseThreshold?: number;
    } = {},
  ) {
    this.abuseStore = options.abuseStore ?? new InMemoryAbuseStore();
    this.incidentStore = options.incidentStore ?? new InMemoryIncidentStore();
    this.ownership = options.ownership;
    this.repeatAbuseThreshold = options.repeatAbuseThreshold ?? 3;
  }

  registerProvider(provider: ComputeProvider): void {
    this.providers.set(provider.name, provider);
  }

  // ---- Abuse -----------------------------------------------------------------

  async openAbuseCase(input: {
    serverOrderId: string;
    complaintSource: AbuseCase["complaintSource"];
    category: string;
    severity: AbuseSeverity;
    evidence?: Array<{ kind: AbuseCase["evidence"][number]["kind"]; reference: string }>;
    deadlineDays?: number;
  }): Promise<AbuseCase> {
    const owner = await this.ownership?.ownerOf(input.serverOrderId);
    if (!owner) throw new PlatformOpsError(`unknown server order ${input.serverOrderId}`);
    const repeatOffenseCount = await this.abuseStore.countCasesFor(owner.orgId);
    const now = nowIso();
    const abuseCase: AbuseCase = {
      caseId: `abuse_${randomUUID().slice(0, 8)}`,
      providerAccountLabel: owner.accountLabel,
      serverOrderId: input.serverOrderId,
      providerInstanceId: owner.providerInstanceId,
      orgId: owner.orgId,
      complaintSource: input.complaintSource,
      category: input.category,
      severity: input.severity,
      status: "open",
      evidence: (input.evidence ?? []).map((e) => ({ ...e, at: now })),
      actions: [{ action: "case_opened", actor: "system", at: now }],
      deadline:
        input.deadlineDays !== undefined
          ? new Date(Date.parse(now) + input.deadlineDays * 24 * 3600_000).toISOString()
          : undefined,
      repeatOffenseCount,
      createdAt: now,
      updatedAt: now,
    };
    if (repeatOffenseCount >= this.repeatAbuseThreshold) {
      this.flaggedOrgs.add(owner.orgId);
    }
    await this.abuseStore.insert(abuseCase);
    return abuseCase;
  }

  addEvidence(caseId: string, evidence: { kind: AbuseCase["evidence"][number]["kind"]; reference: string }): Promise<void> {
    return this.updateCase(caseId, (c) => {
      c.evidence.push({ ...evidence, at: nowIso() });
    });
  }

  /**
   * Emergency suspension through the PROVIDER API — works even when the
   * customer's Mox Node is offline, disabled or modified.
   */
  async emergencySuspendServer(input: { caseId: string; actor: string }): Promise<void> {
    const abuseCase = await this.requireCase(input.caseId);
    if (!abuseCase.providerInstanceId || !abuseCase.serverOrderId) {
      throw new PlatformOpsError("case lacks provider instance reference");
    }
    const owner = await this.ownership?.ownerOf(abuseCase.serverOrderId);
    const providerName = owner?.providerName;
    if (!providerName) throw new PlatformOpsError("server has no provider assignment");
    const provider = this.providers.get(providerName);
    if (!provider || !provider.configured) {
      throw new PlatformOpsError(`provider ${providerName} not available`);
    }
    // Provider-side stop; no dependency on Mox Node whatsoever.
    await provider.stop(abuseCase.providerInstanceId);
    await this.updateCase(input.caseId, (c) => {
      c.status = "mitigated";
      c.actions.push({ action: "emergency_suspended_via_provider", actor: input.actor, at: nowIso() });
    });
  }

  async recordCustomerResponse(caseId: string, response: string): Promise<void> {
    await this.updateCase(caseId, (c) => {
      c.status = "awaiting_customer";
      c.actions.push({ action: `customer_response: ${response}`, actor: "customer", at: nowIso() });
    });
  }

  async resolveCase(input: { caseId: string; actor: string; reinstateServer?: boolean }): Promise<void> {
    const abuseCase = await this.requireCase(input.caseId);
    await this.updateCase(input.caseId, (c) => {
      c.status = "resolved";
      c.actions.push({
        action: input.reinstateServer ? "resolved_server_reinstated" : "resolved",
        actor: input.actor,
        at: nowIso(),
      });
    });
    void abuseCase;
  }

  async dismissCase(caseId: string, actor: string): Promise<void> {
    await this.updateCase(caseId, (c) => {
      c.status = "dismissed";
      c.actions.push({ action: "dismissed", actor, at: nowIso() });
    });
  }

  isRepeatOffender(orgId: string): boolean {
    return this.flaggedOrgs.has(orgId);
  }

  private async updateCase(caseId: string, mutate: (c: AbuseCase) => void): Promise<void> {
    const abuseCase = await this.requireCase(caseId);
    mutate(abuseCase);
    abuseCase.updatedAt = nowIso();
    await this.abuseStore.update(abuseCase);
  }

  private async requireCase(caseId: string): Promise<AbuseCase> {
    const abuseCase = await this.abuseStore.get(caseId);
    if (!abuseCase) throw new PlatformOpsError(`abuse case ${caseId} not found`);
    return abuseCase;
  }

  // ---- Incidents ----------------------------------------------------------------

  async openIncident(input: { kind: IncidentKind; title: string; severity: Severity2; affectedScope: string }): Promise<Incident> {
    const incident: Incident = {
      incidentId: `inc_${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      title: input.title,
      severity: input.severity,
      status: "investigating",
      affectedScope: input.affectedScope,
      startedAt: nowIso(),
      updates: [{ message: "incident opened", at: nowIso() }],
    };
    await this.incidentStore.insert(incident);
    return incident;
  }

  async updateIncident(incidentId: string, message: string, status?: Incident["status"]): Promise<void> {
    const incidents = await this.incidentStore.list();
    const incident = incidents.find((i) => i.incidentId === incidentId);
    if (!incident) throw new PlatformOpsError(`incident ${incidentId} not found`);
    incident.updates.push({ message, at: nowIso() });
    if (status) incident.status = status;
    if (status === "resolved") incident.resolvedAt = nowIso();
    await this.incidentStore.update(incident);
  }

  listIncidents(): Promise<Incident[]> {
    return this.incidentStore.list();
  }
}
