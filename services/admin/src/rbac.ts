/**
 * Admin RBAC (Prompt 13): role model, capability matrix and admin-owned
 * state (account status, support notes, system settings, audit trail).
 *
 * Roles: superadmin (everything), billing_admin, ops_admin, support
 * (read + notes only). Every mutation is audited. The facade delegates to
 * the authoritative services — it never duplicates their state.
 */

export type AdminRole = "superadmin" | "billing_admin" | "ops_admin" | "support";

export interface AdminActor {
  userId: string;
  role: AdminRole;
}

export class AdminAccessError extends Error {
  constructor(required: string) {
    super(`admin access denied: requires ${required}`);
    this.name = "AdminAccessError";
  }
}

export const ROLE_RANK: Record<AdminRole, number> = {
  support: 1,
  billing_admin: 2,
  ops_admin: 2,
  superadmin: 3,
};

/** Which capability each admin area needs. */
export type AdminCapability =
  | "customers.read"
  | "customers.write"
  | "billing.write"
  | "compute.write"
  | "agents.read"
  | "operations.read"
  | "flags.write"
  | "settings.write"
  | "enterprise.write"
  | "costs.read";

export const CAPABILITY_ROLES: Record<AdminCapability, AdminRole[]> = {
  "customers.read": ["superadmin", "billing_admin", "ops_admin", "support"],
  "customers.write": ["superadmin", "ops_admin"],
  "billing.write": ["superadmin", "billing_admin"],
  "compute.write": ["superadmin", "ops_admin"],
  "agents.read": ["superadmin", "ops_admin", "support"],
  "operations.read": ["superadmin", "ops_admin", "support"],
  "flags.write": ["superadmin", "ops_admin"],
  "settings.write": ["superadmin"],
  "enterprise.write": ["superadmin", "billing_admin"],
  "costs.read": ["superadmin", "billing_admin"],
};

export interface SupportNote {
  id: string;
  orgId: string;
  authorUserId: string;
  note: string;
  at: string;
}

export interface OrgAccountRecord {
  orgId: string;
  displayName: string;
  status: "active" | "suspended" | "closed";
  suspendedReason?: string;
  updatedAt: string;
}

export interface SystemSetting {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: string;
}

export interface AdminAuditEntry {
  id: string;
  actor: string;
  capability: string;
  detail: string;
  at: string;
}

export interface AdminStore {
  upsertOrgAccount(record: OrgAccountRecord): Promise<void>;
  getOrgAccount(orgId: string): Promise<OrgAccountRecord | undefined>;
  listOrgAccounts(): Promise<OrgAccountRecord[]>;
  addSupportNote(note: SupportNote): Promise<void>;
  listSupportNotes(orgId: string): Promise<SupportNote[]>;
  setSystemSetting(setting: SystemSetting): Promise<void>;
  getSystemSetting(key: string): Promise<SystemSetting | undefined>;
  appendAudit(entry: AdminAuditEntry): Promise<void>;
  listAudit(): Promise<AdminAuditEntry[]>;
}

export class InMemoryAdminStore implements AdminStore {
  private readonly orgs = new Map<string, OrgAccountRecord>();
  private readonly notes = new Map<string, SupportNote[]>();
  private readonly settings = new Map<string, SystemSetting>();
  private readonly auditLog: AdminAuditEntry[] = [];

  async upsertOrgAccount(record: OrgAccountRecord): Promise<void> {
    this.orgs.set(record.orgId, record);
  }
  async getOrgAccount(orgId: string): Promise<OrgAccountRecord | undefined> {
    return this.orgs.get(orgId);
  }
  async listOrgAccounts(): Promise<OrgAccountRecord[]> {
    return [...this.orgs.values()];
  }
  async addSupportNote(note: SupportNote): Promise<void> {
    const list = this.notes.get(note.orgId) ?? [];
    list.push(note);
    this.notes.set(note.orgId, list);
  }
  async listSupportNotes(orgId: string): Promise<SupportNote[]> {
    return [...(this.notes.get(orgId) ?? [])];
  }
  async setSystemSetting(setting: SystemSetting): Promise<void> {
    this.settings.set(setting.key, setting);
  }
  async getSystemSetting(key: string): Promise<SystemSetting | undefined> {
    return this.settings.get(key);
  }
  async appendAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }
  async listAudit(): Promise<AdminAuditEntry[]> {
    return [...this.auditLog];
  }
}
