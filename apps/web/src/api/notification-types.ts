/** Client-side shape of a durable inbox row (Prompt 02). */
export interface NotificationItem {
  id: string;
  orgId: string;
  userId?: string;
  eventType: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  audienceType: "user" | "users" | "org" | "plan" | "region" | "all";
  category: "system" | "billing" | "servers" | "agents" | "security";
  resourceType?: string;
  resourceId?: string;
  readAt?: string;
  archivedAt?: string;
  createdAt: string;
}
