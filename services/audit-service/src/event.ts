/** 
 * Audit event shape. Every externally visible action in Mox produces one
 * of these, with actor/tenant/action/resource/result/correlation fields and
 * secret-safe before/after snapshots.
 */ 
export interface AuditEvent { 
  id: string; 
  at: string; 
  orgId: string; 
  actorType: "user" | "agent" | "system" | "channel"; 
  actorId?: string; 
  action: string; 
  resourceType?: string; 
  resourceId?: string; 
  result: "success" | "failure" | "denied"; 
  correlationId?: string; 
  before?: unknown; 
  after?: unknown; 
} 
 
export interface AuditEventInput { 
  orgId: string; 
  actorType: AuditEvent["actorType"]; 
  actorId?: string; 
  action: string; 
  resourceType?: string; 
  resourceId?: string; 
  result: AuditEvent["result"]; 
  correlationId?: string; 
  before?: unknown; 
  after?: unknown; 
} 
