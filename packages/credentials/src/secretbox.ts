import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM envelope encryption for secrets at rest. Key material is
 * derived from MOX_CREDENTIALS_KEY (32-byte hex or any passphrase via
 * SHA-256).
 *
 * All NEW ciphertexts use the versioned "v2." prefix and support
 * authenticated associated data (AAD), binding a ciphertext to its owner
 * namespace/reference. Legacy unversioned payloads remain readable so
 * existing installations can rotate/rewrite secrets without an outage.
 * Ciphertext layout (v2): [12-byte nonce][16-byte tag][ciphertext],
 * base64url-encoded after the "v2." prefix.
 */

const V2_PREFIX = "v2.";

export function deriveKey(secret: string): Buffer {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error("credentials key is required");
  if (trimmed.startsWith("hex:")) {
    const hex = trimmed.slice("hex:".length);
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("credentials hex key must be exactly 32 bytes");
    return Buffer.from(hex, "hex");
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (/^[0-9a-fA-F]+$/.test(trimmed)) throw new Error("credentials hex key must be exactly 32 bytes");
  return createHash("sha256").update(trimmed, "utf8").digest();
}

/** Every new ciphertext is versioned so readers can enforce AAD handling. */
export function seal(key: Buffer, plaintext: string, aad?: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payload = Buffer.concat([nonce, cipher.getAuthTag(), enc]).toString("base64url");
  return `${V2_PREFIX}${payload}`;
}

export function open(key: Buffer, sealed: string, aad?: string): string {
  const isV2 = sealed.startsWith(V2_PREFIX);
  const encoded = isV2 ? sealed.slice(V2_PREFIX.length) : sealed;
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length < 12 + 16) throw new Error("sealed payload too short");
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  // Only v2 payloads were created with AAD. Legacy unversioned ciphertext
  // stays readable so existing installations can migrate without an outage.
  if (isV2 && aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}