import { describe, expect, it } from "vitest"; 
import { 
  assertSameTenant, 
  TenantScopeError, 
  requireTenant, 
} from "../src/tenant.js"; 
 
describe("tenant scoping primitives", () => { 
  it("rejects missing or empty tenant context", () => { 
    expect(() => requireTenant(undefined)).toThrow(TenantScopeError); 
    expect(() => requireTenant({ orgId: "" })).toThrow(TenantScopeError); 
  }); 
 
  it("accepts a valid tenant context", () => { 
    expect(requireTenant({ orgId: "org-1" }).orgId).toBe("org-1"); 
  }); 
 
  it("denies cross-tenant row access without system scope", () => { 
    const ctx = { orgId: "org-1" }; 
    expect(() => assertSameTenant(ctx, { orgId: "org-2" })).toThrow(TenantScopeError); 
    expect(() => assertSameTenant(ctx, { orgId: "org-1" })).not.toThrow(); 
  }); 
 
  it("allows cross-tenant reads only with explicit system scope", () => { 
    const ctx = { orgId: "org-1", system: true }; 
    expect(() => assertSameTenant(ctx, { orgId: "org-2" })).not.toThrow(); 
  }); 
 
  it("treats not-found rows as safe", () => { 
    expect(() => assertSameTenant({ orgId: "org-1" }, null)).not.toThrow(); 
  }); 
}); 
