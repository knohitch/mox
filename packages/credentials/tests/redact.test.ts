import { describe, expect, it } from "vitest"; 
import { CREDENTIAL_SCOPES, CredentialService, isCredentialScope, redact } from "../src/service.js"; 
import type { CredentialStore } from "../src/service.js"; 
 
class MemoryStore implements CredentialStore { 
  private readonly map = new Map<string, string>(); 
  async put(ref: { orgId: string; externalId: string }, sealed: string) { 
    this.map.set(`${ref.orgId}:${ref.externalId}`, sealed); 
  } 
  async get(ref: { orgId: string; externalId: string }) { 
    return this.map.get(`${ref.orgId}:${ref.externalId}`) ?? null; 
  } 
} 
 
describe("credential service", () => { 
  it("seals and unseals through a store without exposing plaintext", () => { 
    const store = new MemoryStore(); 
    const svc = new CredentialService("unit-test-master-key", store); 
    const ref = { orgId: "org-1", externalId: "openai-key" }; 
    return svc.setSecret(ref, "sk-live-abcdef123456").then(async () => { 
      const stored = await store.get(ref); 
      expect(stored).toBeTruthy(); 
      expect(stored).not.toContain("sk-live-abcdef123456"); 
      await expect(svc.getSecret(ref)).resolves.toBe("sk-live-abcdef123456"); 
    }); 
  }); 
 
  it("returns null for unknown refs", async () => { 
    const svc = new CredentialService("k", new MemoryStore()); 
    await expect(svc.getSecret({ orgId: "org-x", externalId: "nope" })).resolves.toBeNull(); 
  }); 
}); 
 
describe("redaction", () => { 
  it("redacts secret-looking keys recursively", () => { 
    const input = { 
      apiKey: "sk-should-not-appear", 
      nested: { Authorization: "Bearer xyz", keep: "visible" }, 
      list: [{ password: "hunter2" }, { note: "fine" }], 
    }; 
    const out = JSON.stringify(redact(input)); 
    expect(out).not.toContain("sk-should-not-appear"); 
    expect(out).not.toContain("Bearer xyz"); 
    expect(out).not.toContain("hunter2"); 
    expect(out).toContain("visible"); 
    expect(out).toContain("fine"); 
  }); 
 
  it("keeps the scope set closed", () => { 
    expect(CREDENTIAL_SCOPES).toEqual(["model", "connector", "agent", "mcp", "channel"]); 
    expect(isCredentialScope("model")).toBe(true); 
    expect(isCredentialScope("root")).toBe(false); 
  }); 
}); 
