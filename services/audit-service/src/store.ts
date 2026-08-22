import { randomUUID } from "node:crypto"; 
import { redact } from "@mox/credentials"; 
import type { AuditEvent, AuditEventInput } from "./event.js"; 
 
/** Durable sink for audit events; a Postgres-backed store lands later. */ 
export interface AuditStore { 
  append(event: AuditEvent): Promise<void>; 
  list(orgId: string, options?: { limit?: number }): Promise<AuditEvent[]>; 
} 
 
/** 
 * Audit service facade. Redacts before/after snapshots at the boundary so 
 * no secret material can reach any store implementation. 
 */ 
export class AuditService { 
  constructor(private readonly store: AuditStore) {} 
 
  async record(input: AuditEventInput): Promise<AuditEvent> { 
    const event: AuditEvent = { 
      id: randomUUID(), 
      at: new Date().toISOString(), 
      orgId: input.orgId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action, 
      resourceType: input.resourceType, 
      resourceId: input.resourceId, 
      result: input.result, 
      correlationId: input.correlationId, 
      before: input.before === undefined ? undefined : redact(input.before), 
      after: input.after === undefined ? undefined : redact(input.after), 
    }; 
    await this.store.append(event); 
    return event; 
  } 
 
  list(orgId: string, options?: { limit?: number }): Promise<AuditEvent[]> { 
    return this.store.list(orgId, options); 
  } 
} 
 
/** In-memory store for tests and local development. */ 
export class InMemoryAuditStore implements AuditStore { 
  private readonly events: AuditEvent[] = []; 
 
  async append(event: AuditEvent): Promise<void> { 
    this.events.push(event); 
  } 
 
  async list(orgId: string, options?: { limit?: number }): Promise<AuditEvent[]> { 
    const rows = this.events.filter((event) => event.orgId === orgId); 
    return options?.limit ? rows.slice(-options.limit) : rows; 
  } 
} 
