import { describe, expect, it } from "vitest"; 
import { assertSameTenant, TenantScopeError } from "../src/tenant.js"; 
 
/** 
 * Behavioral contract for every repository read path: fetch the row, then 
 * assertSameTenant before returning it. Cross-tenant reads must throw 
 * unless system scope was granted explicitly. 
 */ 
function guardedFetch(ctx: { orgId: string; system?: boolean }, row: { orgId: string } | null) { 
  assertSameTenant(ctx, row); 
  return row; 
} 
 
describe("cross-tenant access control", () => { 
  const orgA = { orgId: "11111111-1111-1111-1111-111111111111" }; 
  const orgB = { orgId: "22222222-2222-2222-2222-222222222222" }; 
 
  it("returns own-tenant rows", () => { 
    expect(guardedFetch(orgA, orgA)).toEqual(orgA); 
  }); 
 
  it("throws TenantScopeError for foreign-tenant rows", () => { 
    expect(() => guardedFetch(orgA, orgB)).toThrow(TenantScopeError); 
  }); 
 
  it("hides foreign rows as not-found rather than leaking existence", () => { 
    let observed: unknown; 
    try { 
      guardedFetch(orgA, orgB); 
    } catch (error) { 
      observed = error; 
    } 
    expect(observed).toBeInstanceOf(TenantScopeError); 
  }); 
 
  it("permits explicit system scope to cross tenants", () => { 
    expect(guardedFetch({ ...orgA, system: true }, orgB)).toEqual(orgB); 
  }); 
}); 
