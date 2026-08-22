import { describe, expect, it } from "vitest"; 
import { AuditService, InMemoryAuditStore } from "../src/index.js"; 
 
describe("audit service", () => { 
  it("records events with actor, tenant, action, resource, result and correlation", async () => { 
    const svc = new AuditService(new InMemoryAuditStore()); 
    const event = await svc.record({ 
      orgId: "org-1", 
      actorType: "user", 
      actorId: "user-1", 
      action: "agent.update", 
      resourceType: "agent", 
      resourceId: "agent-1", 
      result: "success", 
      correlationId: "corr-1", 
    }); 
    expect(event.id).toBeTruthy(); 
    expect(event.at).toBeTruthy(); 
    const rows = await svc.list("org-1"); 
    expect(rows).toHaveLength(1); 
    expect(rows[0]?.action).toBe("agent.update"); 
  }); 
 
  it("redacts secret-looking keys in before/after snapshots", async () => { 
    const svc = new AuditService(new InMemoryAuditStore()); 
    await svc.record({ 
      orgId: "org-1", 
      actorType: "system", 
      action: "credential.rotate", 
      result: "success", 
      before: { apiKey: "sk-old-secret-value" }, 
      after: { apiKey: "sk-new-secret-value" }, 
    }); 
    const rows = await svc.list("org-1"); 
    const raw = JSON.stringify(rows); 
    expect(raw).not.toContain("sk-old-secret-value"); 
    expect(raw).not.toContain("sk-new-secret-value"); 
  }); 
 
  it("scopes listing by tenant", async () => { 
    const svc = new AuditService(new InMemoryAuditStore()); 
    await svc.record({ orgId: "org-1", actorType: "system", action: "a", result: "success" }); 
    await svc.record({ orgId: "org-2", actorType: "system", action: "b", result: "success" }); 
    expect((await svc.list("org-1")).map((e) => e.action)).toEqual(["a"]); 
    expect((await svc.list("org-2")).map((e) => e.action)).toEqual(["b"]); 
  }); 
}); 
