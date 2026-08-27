import { describe, expect, it } from "vitest";
import {
  createCredentialAuthorities,
  CredentialService,
  CustomerCredentialService,
  SystemCredentialService,
} from "../src/service.js";
import type { CustomerCredentialStore, SystemCredentialStore } from "../src/service.js";

class MemoryCustomerStore implements CustomerCredentialStore {
  private readonly map = new Map<string, string>();
  async put(ref: { orgId: string; externalId: string }, sealed: string) {
    this.map.set(`${ref.orgId}:${ref.externalId}`, sealed);
  }
  async get(ref: { orgId: string; externalId: string }) {
    return this.map.get(`${ref.orgId}:${ref.externalId}`) ?? null;
  }
  secrets(): Map<string, string> {
    return this.map;
  }
}

class MemorySystemStore implements SystemCredentialStore {
  private readonly map = new Map<string, string>();
  async put(ref: { externalId: string }, sealed: string) {
    this.map.set(ref.externalId, sealed);
  }
  async get(ref: { externalId: string }) {
    return this.map.get(ref.externalId) ?? null;
  }
  secrets(): Map<string, string> {
    return this.map;
  }
}

describe("credential authority separation", () => {
  it("round-trips customer secrets bound to org + external id", async () => {
    const store = new MemoryCustomerStore();
    const svc = new CustomerCredentialService("unit-test-master-key", store);
    const ref = { orgId: "org-1", externalId: "openai-key" };
    await svc.setSecret(ref, "sk-customer-1");
    expect(await svc.getSecret(ref)).toBe("sk-customer-1");
    expect(store.secrets().get("org-1:openai-key")).toMatch(/^v2\./);
  });

  it("round-trips Mox-system secrets with no organization namespace", async () => {
    const store = new MemorySystemStore();
    const svc = new SystemCredentialService("unit-test-master-key", store);
    await svc.setSecret({ externalId: "mox:openai:MOX_INTEL_OPENAI_API_KEY" }, "sk-system-1");
    expect(await svc.getSecret({ externalId: "mox:openai:MOX_INTEL_OPENAI_API_KEY" })).toBe("sk-system-1");
    expect(store.secrets().get("mox:openai:MOX_INTEL_OPENAI_API_KEY")).toMatch(/^v2\./);
  });

  it("rejects the same cryptographic root for customer and system authorities", () => {
    expect(() =>
      createCredentialAuthorities({
        customerMasterKey: "same-root-passphrase",
        systemMasterKey: "same-root-passphrase",
        customerStore: new MemoryCustomerStore(),
        systemStore: new MemorySystemStore(),
      }),
    ).toThrow(/must be different/);
  });

  it("rejects the same root across different encodings of the same key", () => {
    const hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(() =>
      createCredentialAuthorities({
        customerMasterKey: hex,
        systemMasterKey: `hex:${hex}`,
        customerStore: new MemoryCustomerStore(),
        systemStore: new MemorySystemStore(),
      }),
    ).toThrow(/must be different/);
  });

  it("keeps the current weak/short master-key policy (passphrase allowed)", async () => {
    const store = new MemoryCustomerStore();
    const svc = new CredentialService("k", store);
    await svc.setSecret({ orgId: "org-1", externalId: "short-key" }, "value");
    await expect(svc.getSecret({ orgId: "org-1", externalId: "short-key" })).resolves.toBe("value");
  });

it("allows distinct short passphrases through createCredentialAuthorities", () => {
    const { customer, system } = createCredentialAuthorities({
      customerMasterKey: "password",
      systemMasterKey: "passphrase",
      customerStore: new MemoryCustomerStore(),
      systemStore: new MemorySystemStore(),
    });
    expect(customer).toBeInstanceOf(CustomerCredentialService);
    expect(system).toBeInstanceOf(SystemCredentialService);
  });

  it("customer ciphertext cannot decrypt through the system authority", async () => {
    const customerStore = new MemoryCustomerStore();
    const systemStore = new MemorySystemStore();
    const svc = new CustomerCredentialService("customer-key", customerStore);
    const ref = { orgId: "org-1", externalId: "key-1" };
    await svc.setSecret(ref, "do-not-leak");
    const customerCiphertext = customerStore.secrets().get("org-1:key-1")!;
    // Force the customer ciphertext into the system store: even when the
    // system store can reach it, the system AAD must reject it.
    await systemStore.put({ externalId: "key-1" }, customerCiphertext);
    const systemSvc = new SystemCredentialService("customer-key", systemStore);
    await expect(systemSvc.getSecret({ externalId: "key-1" })).rejects.toThrow();
  });

  it("system ciphertext cannot decrypt through the customer authority", async () => {
    const customerStore = new MemoryCustomerStore();
    const systemStore = new MemorySystemStore();
    const systemSvc = new SystemCredentialService("system-key", systemStore);
    await systemSvc.setSecret({ externalId: "key-1" }, "platform-secret");
    const systemCiphertext = systemStore.secrets().get("key-1")!;
    await customerStore.put({ orgId: "org-1", externalId: "key-1" }, systemCiphertext);
    const customerSvc = new CustomerCredentialService("system-key", customerStore);
    await expect(customerSvc.getSecret({ orgId: "org-1", externalId: "key-1" })).rejects.toThrow();
  });

  it("rejects empty refs rather than writing unaddressable secrets", async () => {
    const svc = new CustomerCredentialService("k", new MemoryCustomerStore());
    await expect(svc.setSecret({ orgId: "", externalId: "k" }, "x")).rejects.toThrow();
    const sysSvc = new SystemCredentialService("k", new MemorySystemStore());
    await expect(sysSvc.setSecret({ externalId: "" }, "x")).rejects.toThrow();
  });
});