/**
 * Password credential hashing (Prompt 00B §B).
 *
 * Uses Node's built-in scrypt KDF — a modern, memory-hard KDF — with a
 * per-password random salt and timing-safe verification. Format:
 *   scrypt$N$r$p$saltB64$hashB64
 * Plaintext, reversible encryption and bare digests are forbidden by
 * contract. Passwords/hashes are never logged anywhere.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** OWASP-recommended baseline for interactive logins. */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

export const PASSWORD_ALGORITHM = "scrypt";

export function assertPasswordPolicy(password: string): void {
  if (!password || password.length < 12) {
    throw new Error("password must be at least 12 characters");
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: 128 * PARAMS.N * PARAMS.r * 2 });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== PASSWORD_ALGORITHM) return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0 || r <= 0 || p <= 0) {
    return false;
  }
  try {
    const salt = Buffer.from(saltB64!, "base64");
    const expected = Buffer.from(hashB64!, "base64");
    const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
