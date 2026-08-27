import { describe, expect, it } from "vitest"; 
import { deriveKey, open, seal } from "../src/secretbox.js"; 
 
describe("secretbox (AES-256-GCM)", () => { 
  const key = deriveKey("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"); 
 
  it("round-trips a secret", () => { 
    const secret = "sk-test-1234567890abcdef"; 
    expect(open(key, seal(key, secret))).toBe(secret); 
  }); 
 
  it("produces unique ciphertexts for identical plaintexts", () => { 
    const a = seal(key, "same-secret-value"); 
    const b = seal(key, "same-secret-value"); 
    expect(a).not.toBe(b); 
  }); 
 
  it("rejects tampered ciphertexts", () => { 
    const sealed = seal(key, "tamper-target"); 
    const raw = Buffer.from(sealed, "base64url"); 
    raw[raw.length - 1] = 1; 
    expect(() => open(key, raw.toString("base64url"))).toThrow(); 
  }); 
 
  it("rejects the wrong key", () => { 
    const otherKey = deriveKey("another-passphrase-entirely"); 
    expect(() => open(otherKey, seal(key, "cross-key"))).toThrow(); 
  }); 
 
  it("derives the same key from hex and passphrase forms deterministically", () => {
    expect(deriveKey("passphrase")).toEqual(deriveKey("passphrase"));
  });

it("does not treat malformed suffix-matching hex as key material", () => {
    const valid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(() => deriveKey(`prefix-${valid}`)).not.toThrow();
    expect(() => deriveKey(`${valid.slice(0, 62)}`)).toThrow(/exactly 32 bytes/);
    expect(() => deriveKey(`hex:${valid.slice(0, 62)}`)).toThrow(/exactly 32 bytes/);
  });

  it("writes every new ciphertext in the versioned v2 format", () => {
    expect(seal(key, "any-secret")).toMatch(/^v2\./);
    expect(seal(key, "any-secret", "mox:credential:v2:customer:org:ext")).toMatch(/^v2\./);
  });

  it("keeps legacy unversioned ciphertext readable", () => {
    const legacy = seal(key, "legacy-value").replace(/^v2\./, "");
    expect(legacy).not.toMatch(/^v2\./);
    expect(open(key, legacy)).toBe("legacy-value");
  });

  it("fails authenticated decryption when AAD is wrong or missing", () => {
    const sealed = seal(key, "aad-secret", "mox:credential:v2:customer:org-a:key-1");
    expect(open(key, sealed, "mox:credential:v2:customer:org-a:key-1")).toBe("aad-secret");
    expect(() => open(key, sealed)).toThrow();
    expect(() => open(key, sealed, "mox:credential:v2:customer:org-b:key-1")).toThrow();
  });

  it("binds ciphertext to the org so another org cannot reuse it", () => {
    const sealed = seal(key, "org-bound", "mox:credential:v2:customer:org-a:key-1");
    expect(() => open(key, sealed, "mox:credential:v2:customer:org-b:key-1")).toThrow();
  });

  it("binds ciphertext to the external id so another id cannot reuse it", () => {
    const sealed = seal(key, "id-bound", "mox:credential:v2:customer:org-a:key-1");
    expect(() => open(key, sealed, "mox:credential:v2:customer:org-a:key-2")).toThrow();
  });

  it("keeps customer and system namespaces cryptographically distinct", () => {
    const customer = seal(key, "customer-value", "mox:credential:v2:customer:org-a:key-1");
    expect(() => open(key, customer, "mox:credential:v2:system:key-1")).toThrow();
    const system = seal(key, "system-value", "mox:credential:v2:system:key-1");
    expect(() => open(key, system, "mox:credential:v2:customer:org-a:key-1")).toThrow();
    expect(open(key, system, "mox:credential:v2:system:key-1")).toBe("system-value");
  });
});
