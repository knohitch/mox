import { deriveKey, open, seal } from "./secretbox.js"; 
 
/** 
 * Credential scopes, adapted from OpenBot credential kinds (model, 
 * connector, agent, mcp) into a closed set. Scope gates which services 
 * may request a secret at runtime. 
 */ 
export const CREDENTIAL_SCOPES = ["model", "connector", "agent", "mcp", "channel"] as const; 
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number]; 
 
export function isCredentialScope(value: string): value is CredentialScope { 
  return (CREDENTIAL_SCOPES as readonly string[]).includes(value); 
} 
 
/** 
 * Redaction for audit trails and logs: keys that look like secrets are 
 * replaced with a redaction marker, recursively. 
 */ 
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key|session)/i; 
 
export function redact(value: unknown, depth = 0): unknown { 
  if (depth > 6) return "[depth-limit]"; 
  if (value === null || typeof value !== "object") return value; 
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1)); 
  const out: Record<string, unknown> = {}; 
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) { 
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(item, depth + 1); 
  } 
  return out; 
} 
 
/** 
 * Credential service: encrypts secrets at rest with AES-256-GCM and 
 * returns sealed payloads for storage. Storage backends plug in via 
 * CredentialStore; this package never persists anything itself. 
 */ 
export interface CredentialStore { 
  put(ref: { orgId: string; externalId: string }, sealed: string): Promise<void>; 
  get(ref: { orgId: string; externalId: string }): Promise<string | null>; 
} 
 
export class CredentialService { 
  private readonly key: Buffer; 
 
  constructor(masterKey: string, private readonly store: CredentialStore) { 
    if (!masterKey) throw new Error("MOX_CREDENTIALS_KEY is required"); 
    this.key = deriveKey(masterKey); 
  } 
 
  async setSecret(ref: { orgId: string; externalId: string }, secret: string): Promise<void> { 
    await this.store.put(ref, seal(this.key, secret)); 
  } 
 
  async getSecret(ref: { orgId: string; externalId: string }): Promise<string | null> { 
    const sealed = await this.store.get(ref); 
    if (sealed === null) return null; 
    return open(this.key, sealed); 
  } 
} 
