import { and, eq } from "drizzle-orm"; 
import type { MoxDb } from "./client.js"; 
import { agents, organizations } from "./schema/index.js"; 
import { assertSameTenant, requireTenant, type TenantContext } from "./tenant.js"; 
 
/** 
 * Tenant-scoped repositories. Every method takes a TenantContext; there is 
 * no way to query tenant-owned rows without one. System scope must be set 
 * explicitly by trusted server code. 
 */ 
export class OrgRepo { 
  constructor(private readonly db: MoxDb) {} 
 
  async create(input: { slug: string; displayName: string }): Promise<{ id: string }> { 
    const [row] = await this.db.insert(organizations).values(input).returning({ id: organizations.id }); 
    if (!row) throw new Error("insert organization returned no row"); 
    return row; 
  } 
 
  async findBySlug(ctx: TenantContext, slug: string) { 
    requireTenant(ctx); 
    const rows = await this.db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1); 
    const row = rows[0] ?? null; 
    if (row && !ctx.system && row.id !== ctx.orgId) return null; 
    return row; 
  } 
} 
 
export class AgentRepo { 
  constructor(private readonly db: MoxDb) {} 
 
  async create(ctx: TenantContext, input: { slug: string; displayName: string; definition: unknown }) { 
    const tenant = requireTenant(ctx); 
    const [row] = await this.db 
      .insert(agents) 
      .values({ orgId: tenant.orgId, slug: input.slug, displayName: input.displayName, definition: input.definition as object }) 
      .returning(); 
    if (!row) throw new Error("insert agent returned no row"); 
    return row; 
  } 
 
  async findBySlug(ctx: TenantContext, slug: string) { 
    const tenant = requireTenant(ctx); 
    const rows = await this.db 
      .select() 
      .from(agents) 
      .where(and(eq(agents.orgId, tenant.orgId), eq(agents.slug, slug))) 
      .limit(1); 
    const row = rows[0] ?? null; 
    assertSameTenant(ctx, row ?? undefined); 
    return row; 
  } 
} 
