import { 
  createCipheriv, 
  createDecipheriv, 
  createHash, 
  randomBytes, 
} from "node:crypto"; 
 
/** 
 * AES-256-GCM envelope encryption for secrets at rest. Key material is 
 * derived from MOX_CREDENTIALS_KEY (32-byte hex or any passphrase via 
 * SHA-256). Ciphertext layout: [12-byte nonce][16-byte tag][ciphertext], 
 * base64url-encoded. 
 */ 
 
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
 
export function seal(key: Buffer, plaintext: string): string { 
  const nonce = randomBytes(12); 
  const cipher = createCipheriv("aes-256-gcm", key, nonce); 
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]); 
  return Buffer.concat([nonce, cipher.getAuthTag(), enc]).toString("base64url"); 
} 
 
export function open(key: Buffer, sealed: string): string { 
  const raw = Buffer.from(sealed, "base64url"); 
  if (raw.length < 12 + 16) throw new Error("sealed payload too short"); 
  const nonce = raw.subarray(0, 12); 
  const tag = raw.subarray(12, 28); 
  const enc = raw.subarray(28); 
  const decipher = createDecipheriv("aes-256-gcm", key, nonce); 
  decipher.setAuthTag(tag); 
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8"); 
} 
