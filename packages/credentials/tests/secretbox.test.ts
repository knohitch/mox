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
}); 
