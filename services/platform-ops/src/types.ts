/**
 * Platform operations (Prompt 12): abuse case management and incident
 * records. Abuse workflow can identify and emergency-suspend an offending
 * VPS through the PROVIDER API even when the customer's Mox Node is offline.
 */

export type AbuseSeverity = "low" | "medium" | "high" | "critical";

export interface AbuseCase {
  caseId: string;
  /** Provider account involved — blast radius tracking. */
  providerAccountLabel?: string;
  serverOrderId?: string;
  providerInstanceId?: string;
  orgId: string;
  complaintSource: "upstream_provider" | "spam_report" | "legal" | "internal_monitoring" | "customer_complaint";
  category: string;
  severity: AbuseSeverity;
  status: "open" | "awaiting_customer" | "mitigated" | "resolved" | "dismissed";
  evidence: Array<{ kind: "log_excerpt" | "email" | "screenshot_ref" | "url"; reference: string; at: string }>;
  actions: Array<{ action: string; actor: string; at: string }>;
  deadline?: string;
  repeatOffenseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServerOwnershipLookup {
  ownerOf(serverOrderId: string): Promise<{ orgId: string; providerName?: string; providerInstanceId?: string; accountLabel?: string } | undefined>;
}

export interface AbuseStore {
  insert(abbuseCase: AbuseCase): Promise<boolean>;
  get(caseId: string): Promise<AbuseCase | undefined>;
  update(abuseCase: AbuseCase): Promise<void>;
  listOpen(): Promise<AbuseCase[]>;
  countCasesFor(orgId: string): Promise<number>;
}

export class InMemoryAbuseStore implements AbuseStore {
  private readonly cases = new Map<string, AbuseCase>();

  async insert(abuseCase: AbuseCase): Promise<boolean> {
    if (this.cases.has(abuseCase.caseId)) return false;
    this.cases.set(abuseCase.caseId, abuseCase);
    return true;
  }

  async get(caseId: string): Promise<AbuseCase | undefined> {
    return this.cases.get(caseId);
  }

  async update(abuseCase: AbuseCase): Promise<void> {
    abuseCase.updatedAt = new Date().toISOString();
    this.cases.set(abuseCase.caseId, abuseCase);
  }

  async listOpen(): Promise<AbuseCase[]> {
    return [...this.cases.values()].filter((c) => !["resolved", "dismissed"].includes(c.status));
  }

  async countCasesFor(orgId: string): Promise<number> {
    return [...this.cases.values()].filter((c) => c.orgId === orgId).length;
  }
}

// ---- Incidents -----------------------------------------------------------------

export type IncidentKind = "provider_outage" | "model_outage" | "channel_outage" | "mox_service";

export interface Incident {
  incidentId: string;
  kind: IncidentKind;
  title: string;
  severity: Severity2;
  status: "investigating" | "identified" | "monitoring" | "resolved";
  affectedScope: string;
  startedAt: string;
  resolvedAt?: string;
  updates: Array<{ message: string; at: string }>;
}

export type Severity2 = "minor" | "major" | "critical";

export interface IncidentStore {
  insert(incident: Incident): Promise<boolean>;
  update(incident: Incident): Promise<void>;
  list(): Promise<Incident[]>;
}

export class InMemoryIncidentStore implements IncidentStore {
  private readonly items = new Map<string, Incident>();
  async insert(incident: Incident): Promise<boolean> {
    if (this.items.has(incident.incidentId)) return false;
    this.items.set(incident.incidentId, incident);
    return true;
  }
  async update(incident: Incident): Promise<void> {
    this.items.set(incident.incidentId, incident);
  }
  async list(): Promise<Incident[]> {
    return [...this.items.values()];
  }
}
