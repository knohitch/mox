import { timingSafeEqual } from "node:crypto";
import { deriveKey, open, seal } from "./secretbox.js";

/** Customer-manageable credential scopes. */
export const CREDENTIAL_SCOPES = ["model", "connector", "agent", "mcp", "channel"] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

/** Mox-owned operational secret scopes. Never addressable through an org id. */
export const SYSTEM_CREDENTIAL_SCOPES = ["model", "connector", "channel", "compute", "billing", "platform"] as const;
export type SystemCredentialScope = (typeof SYSTEM_CREDENTIAL_SCOPES)[number];

export function isCredentialScope(value: string): value is CredentialScope {
  return (CREDENTIAL_SCOPES as readonly string[]).includes(value);
}

export function isSystemCredentialScope(value: string): value is SystemCredentialScope {
  return (SYSTEM_CREDENTIAL_SCOPES as readonly string[]).includes(value);
}

/** Redact secret-looking fields before values leave a trusted service boundary. */
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

export interface CustomerCredentialRef {
  orgId: string;
  externalId: string;
}

export interface SystemCredentialRef {
  externalId: string;
}

/** Storage authority reachable by customer/workspace credential code only. */
export interface CustomerCredentialStore {
  put(ref: CustomerCredentialRef, sealed: string): Promise<void>;
  get(ref: CustomerCredentialRef): Promise<string | null>;
}

/** Storage authority reachable by Mox platform code only. */
export interface SystemCredentialStore {
  put(ref: SystemCredentialRef, sealed: string): Promise<void>;
  get(ref: SystemCredentialRef): Promise<string | null>;
}

abstract class BaseCredentialService<Ref> {
  protected readonly key: Buffer;

  protected constructor(masterKey: string) {
    assertStrongMasterKey(masterKey);
    this.key = deriveKey(masterKey);
  }

  protected sealFor(aad: string, secret: string): string {
    return seal(this.key, secret, aad);
  }

  protected openFor(aad: string, payload: string): string {
    return open(this.key, payload, aad);
  }

  abstract setSecret(ref: Ref, secret: string): Promise<void>;
  abstract getSecret(ref: Ref): Promise<string | null>;
}

/**
 * Customer credential service. Every address requires an orgId and ciphertext
 * is authenticated against that exact org/external-id tuple.
 */
export class CustomerCredentialService extends BaseCredentialService<CustomerCredentialRef> {
  constructor(masterKey: string, private readonly store: CustomerCredentialStore) {
    super(masterKey);
  }

  async setSecret(ref: CustomerCredentialRef, secret: string): Promise<void> {
    validateCustomerRef(ref);
    await this.store.put(ref, this.sealFor(customerAad(ref), secret));
  }

  async getSecret(ref: CustomerCredentialRef): Promise<string | null> {
    validateCustomerRef(ref);
    const payload = await this.store.get(ref);
    return payload === null ? null : this.openFor(customerAad(ref), payload);
  }
}

/**
 * Mox-owned credential service. There is deliberately no orgId on this API,
 * so customer-scoped code cannot address platform secrets through a special
 * or synthetic organization.
 */
export class SystemCredentialService extends BaseCredentialService<SystemCredentialRef> {
  constructor(masterKey: string, private readonly store: SystemCredentialStore) {
    super(masterKey);
  }

  async setSecret(ref: SystemCredentialRef, secret: string): Promise<void> {
    validateSystemRef(ref);
    await this.store.put(ref, this.sealFor(systemAad(ref), secret));
  }

  async getSecret(ref: SystemCredentialRef): Promise<string | null> {
    validateSystemRef(ref);
    const payload = await this.store.get(ref);
    return payload === null ? null : this.openFor(systemAad(ref), payload);
  }
}

/**
 * Compose both authorities and enforce independent cryptographic roots.
 * Production startup should use this rather than sharing one key between
 * customer BYOK data and Mox-managed provider credentials.
 */
export function createCredentialAuthorities(input: {
  customerMasterKey: string;
  systemMasterKey: string;
  customerStore: CustomerCredentialStore;
  systemStore: SystemCredentialStore;
}): { customer: CustomerCredentialService; system: SystemCredentialService } {
  assertStrongMasterKey(input.customerMasterKey);
  assertStrongMasterKey(input.systemMasterKey);
  if (sameSecret(input.customerMasterKey, input.systemMasterKey)) {
    throw new Error("customer and Mox system credential master keys must be different");
  }
  return {
    customer: new CustomerCredentialService(input.customerMasterKey, input.customerStore),
    system: new SystemCredentialService(input.systemMasterKey, input.systemStore),
  };
}

/**
 * Backward-compatible customer-only name. Existing callers keep working, but
 * system credentials require the distinct SystemCredentialService type.
 */
export class CredentialService extends CustomerCredentialService {}
export type CredentialStore = CustomerCredentialStore;

function customerAad(ref: CustomerCredentialRef): string {
  return `mox:credential:v2:customer:${ref.orgId}:${ref.externalId}`;
}

function systemAad(ref: SystemCredentialRef): string {
  return `mox:credential:v2:system:${ref.externalId}`;
}

function validateCustomerRef(ref: CustomerCredentialRef): void {
  if (!ref.orgId.trim()) throw new Error("customer credential orgId is required");
  if (!ref.externalId.trim()) throw new Error("customer credential externalId is required");
}

function validateSystemRef(ref: SystemCredentialRef): void {
  if (!ref.externalId.trim()) throw new Error("system credential externalId is required");
}

function assertStrongMasterKey(secret: string): void {
  if (!secret) throw new Error("credential master key is required");
  const isHex256 = /^[0-9a-fA-F]{64}$/.test(secret);
  if (!isHex256 && Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("credential master key must contain at least 32 bytes of key material");
  }
}

function sameSecret(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
