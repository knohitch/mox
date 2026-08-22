import { describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { deriveKey, open, seal } from "../src/secretbox.js";

describe("secretbox (AES-256-GCM)", () => {
  const key = deriveKey("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

  it("round-trips a v2 secret with associated data", () => {
    const secret = "test-secret-value";
    const aad = "mox:credential:v2:customer:org-1:provider-key";
    const sealed = seal(key, secret, aad);
    expect(sealed.startsWith("v2.")).toBe(true);
    expect(open(key, sealed, aad)).toBe(secret);
  });

  it("produces unique ciphertexts for identical plaintexts", () => {
    const aad = "mox:credential:v2:system:provider-key";
    const a = seal(key, "same-secret-value", aad);
    const b = seal(key, "same-secret-value", aad);
    expect(a).not.toBe(b);
  });

  it("rejects a v2 ciphertext under different associated data", () => {
    const sealed = seal(key, "owner-bound", "mox:credential:v2:customer:org-a:key");
    expect(() => open(key, sealed, "mox:credential:v2:customer:org-b:key")).toThrow();
  });

  it("rejects tampered v2 ciphertexts", () => {
    const aad = "mox:credential:v2:system:gateway-key";
    const sealed = seal(key, "tamper-target", aad);
    const payload = sealed.slice("v2.".length);
    const raw = Buffer.from(payload, "base64url");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => open(key, `v2.${raw.toString("base64url")}`, aad)).toThrow();
  });

  it("rejects the wrong key", () => {
    const otherKey = deriveKey("another-passphrase-entirely");
    const aad = "mox:credential:v2:system:key";
    expect(() => open(otherKey, seal(key, "cross-key", aad), aad)).toThrow();
  });

  it("continues reading legacy unversioned ciphertext during migration", () => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const plaintext = "legacy-secret";
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const legacy = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
    expect(open(key, legacy, "ignored-for-v1")).toBe(plaintext);
  });

  it("derives the same key deterministically", () => {
    expect(deriveKey("passphrase")).toEqual(deriveKey("passphrase"));
  });
});
