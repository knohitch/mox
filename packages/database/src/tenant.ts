/**
 * Tenant scoping primitives.
 *
 * Every tenant-owned durable object in the Mox schema carries an explicit
 * `orgId`. Repository and service methods REQUIRE a `TenantContext`; there is
 * no overload that omits it, so a missing tenant is a type error at the call
 * site and a thrown error at runtime. Admin/system scope is an explicit flag,
 * never "no tenant id".
 */

/** Thrown when a data access would cross tenant boundaries or lack one. */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

export interface TenantContext {
  /** Owning organization/workspace. Required for every tenant-scoped call. */
  orgId: string;
  /** Acting user, when the call is made on behalf of a person. */
  actorUserId?: string;
  /**
   * Explicit system/admin scope. When true the caller may read across
   * tenants; this must only be granted by trusted server-side code paths.
   */
  system?: boolean;
}

/** A row that belongs to exactly one organization. */
export interface OrgScopedRow {
  orgId: string;
}

export function requireTenant(ctx: TenantContext | undefined): TenantContext & { orgId: string } {
  if (!ctx || typeof ctx.orgId !== "string" || ctx.orgId.length === 0) {
    throw new TenantScopeError("tenant context with a non-empty orgId is required");
  }
  return ctx as TenantContext & { orgId: string };
}

/**
 * Guard used by repositories before reading or writing a fetched row: the
 * row's org must match the caller's org unless the caller holds explicit
 * system scope.
 */
export function assertSameTenant(
  ctx: TenantContext | undefined,
  row: OrgScopedRow | null | undefined,
): void {
  const tenant = requireTenant(ctx);
  if (tenant.system) return;
  if (!row) return; // not-found is handled by callers; nothing to leak
  if (row.orgId !== tenant.orgId) {
    throw new TenantScopeError("cross-tenant access denied");
  }
}