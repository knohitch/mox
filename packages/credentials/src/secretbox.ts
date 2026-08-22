import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM envelope encryption for secrets at rest.
 *
 * v2 ciphertexts include authenticated associated data (AAD), allowing the
 * credential service to bind a ciphertext to its owner namespace/reference.
 * Legacy unversioned payloads remain readable for migration, but every new
 * write is v2.
 */

const V2_PREFIX = "v2.";

export function deriveKey(secret: string): Buffer {
  if (/[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, "hex");
  return createHash("sha256").update(secret, "utf8").digest();
}

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
  // Only v2 payloads were created with AAD. Unversioned v1 stays readable so
  // existing installations can rotate/rewrite secrets without an outage.
  if (isV2 && aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
