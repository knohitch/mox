import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SCOPES,
  SYSTEM_CREDENTIAL_SCOPES,
  CredentialService,
  CustomerCredentialService,
  SystemCredentialService,
  createCredentialAuthorities,
  isCredentialScope,
  isSystemCredentialScope,
  redact,
} from "../src/service.js";
import type {
  CustomerCredentialRef,
  CustomerCredentialStore,
  SystemCredentialRef,
  SystemCredentialStore,
} from "../src/service.js";

const CUSTOMER_KEY = "customer-test-master-key-material-000000000001";
const SYSTEM_KEY = "system-test-master-key-material-00000000000002";

class MemoryCustomerStore implements CustomerCredentialStore {
  readonly map = new Map<string, string>();

  async put(ref: CustomerCredentialRef, sealed: string) {
    this.map.set(`${ref.orgId}:${ref.externalId}`, sealed);
  }

  async get(ref: CustomerCredentialRef) {
    return this.map.get(`${ref.orgId}:${ref.externalId}`) ?? null;
  }
}

class MemorySystemStore implements SystemCredentialStore {
  readonly map = new Map<string, string>();

  async put(ref: SystemCredentialRef, sealed: string) {
    this.map.set(ref.externalId, sealed);
  }

  async get(ref: SystemCredentialRef) {
    return this.map.get(ref.externalId) ?? null;
  }
}

describe("credential authority isolation", () => {
  it("seals and unseals customer credentials without exposing plaintext", async () => {
    const store = new MemoryCustomerStore();
    const svc = new CredentialService(CUSTOMER_KEY, store);
    const ref = { orgId: "org-1", externalId: "provider-key" };
    await svc.setSecret(ref, "secret-customer-value");
    const stored = await store.get(ref);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("secret-customer-value");
    await expect(svc.getSecret(ref)).resolves.toBe("secret-customer-value");
  });

  it("returns null for unknown customer refs", async () => {
    const svc = new CustomerCredentialService(CUSTOMER_KEY, new MemoryCustomerStore());
    await expect(svc.getSecret({ orgId: "org-x", externalId: "nope" })).resolves.toBeNull();
  });

  it("cryptographically binds customer ciphertext to the organization address", async () => {
    const store = new MemoryCustomerStore();
    const svc = new CustomerCredentialService(CUSTOMER_KEY, store);
    const source = { orgId: "org-a", externalId: "provider-key" };
    const destination = { orgId: "org-b", externalId: "provider-key" };
    await svc.setSecret(source, "customer-secret");
    const sealed = await store.get(source);
    expect(sealed).toBeTruthy();
    store.map.set(`${destination.orgId}:${destination.externalId}`, sealed!);
    await expect(svc.getSecret(destination)).rejects.toThrow();
  });

  it("uses a separate Mox system address surface and encryption root", async () => {
    const customerStore = new MemoryCustomerStore();
    const systemStore = new MemorySystemStore();
    const authorities = createCredentialAuthorities({
      customerMasterKey: CUSTOMER_KEY,
      systemMasterKey: SYSTEM_KEY,
      customerStore,
      systemStore,
    });

    await authorities.customer.setSecret({ orgId: "org-1", externalId: "provider-key" }, "customer-secret");
    await authorities.system.setSecret({ externalId: "managed-provider-key" }, "system-secret");

    expect(customerStore.map.has("org-1:provider-key")).toBe(true);
    expect(customerStore.map.has("managed-provider-key")).toBe(false);
    expect(systemStore.map.has("managed-provider-key")).toBe(true);
    expect(systemStore.map.has("org-1:provider-key")).toBe(false);
    await expect(authorities.system.getSecret({ externalId: "managed-provider-key" })).resolves.toBe("system-secret");
  });

  it("rejects a shared customer/system master key", () => {
    expect(() =>
      createCredentialAuthorities({
        customerMasterKey: CUSTOMER_KEY,
        systemMasterKey: CUSTOMER_KEY,
        customerStore: new MemoryCustomerStore(),
        systemStore: new MemorySystemStore(),
      }),
    ).toThrow(/must be different/);
  });

  it("rejects weak master keys", () => {
    expect(() => new CustomerCredentialService("short", new MemoryCustomerStore())).toThrow(/at least 32 bytes/);
    expect(() => new SystemCredentialService("short", new MemorySystemStore())).toThrow(/at least 32 bytes/);
  });
});

describe("redaction", () => {
  it("redacts secret-looking keys recursively", () => {
    const input = {
      apiKey: "secret-value",
      nested: { Authorization: "Bearer xyz", keep: "visible" },
      list: [{ password: "hunter2" }, { note: "fine" }],
    };
    const out = JSON.stringify(redact(input));
    expect(out).not.toContain("secret-value");
    expect(out).not.toContain("Bearer xyz");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("visible");
    expect(out).toContain("fine");
  });

  it("keeps customer and system scope sets closed", () => {
    expect(CREDENTIAL_SCOPES).toEqual(["model", "connector", "agent", "mcp", "channel"]);
    expect(SYSTEM_CREDENTIAL_SCOPES).toEqual(["model", "connector", "channel", "compute", "billing", "platform"]);
    expect(isCredentialScope("model")).toBe(true);
    expect(isCredentialScope("billing")).toBe(false);
    expect(isSystemCredentialScope("billing")).toBe(true);
    expect(isSystemCredentialScope("root")).toBe(false);
  });
});
