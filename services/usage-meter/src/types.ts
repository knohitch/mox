/**
 * Usage meter (Prompt 12): canonical ingestion and aggregation of all
 * metered quantities with tenant/user/agent/server/provider dimensions.
 */

export type UsageKind =
  | "ai_input_tokens"
  | "ai_output_tokens"
  | "ai_cache_tokens"
  | "agent_runs"
  | "browser_minutes"
  | "browser_concurrency_peak"
  | "cli_sessions"
  | "storage_gb_hours"
  | "workflow_runs"
  | "channel_messages"
  | "voice_minutes"
  | "api_requests"
  | "compute_node_hours"
  | "backup_storage_gb";

export interface UsageDimensions {
  orgId: string;
  userId?: string;
  agentId?: string;
  serverId?: string;
  providerName?: string;
}

export interface UsageEvent {
  eventId?: string;
  kind: UsageKind;
  dimensions: UsageDimensions;
  quantity: number;
  at: string;
  /** Overage-ready pricing reference set by admins per kind. */
  priceRef?: string;
}

export type UsageLimitKind = "included" | "soft" | "hard" | "overage_ref";

export interface UsageLimit {
  orgId: string;
  planVersionId: string;
  kind: UsageKind;
  /** -1 = unlimited. */
  includedQuantity: number;
  softLimitQuantity?: number;
  hardLimitQuantity?: number;
  overagePriceRef?: string;
}

export interface UsageAggregate {
  kind: UsageKind;
  dimensions: Partial<UsageDimensions>;
  periodStart: string;
  periodEnd: string;
  total: number;
}

export interface UsageStore {
  append(event: UsageEvent & { eventId: string }): Promise<boolean>;
  aggregates(): Promise<UsageAggregate[]>;
  upsertAggregate(aggregate: UsageAggregate): Promise<void>;
  upsertLimit(limit: UsageLimit): Promise<void>;
  getLimit(orgId: string, kind: UsageKind, planVersionId: string): Promise<UsageLimit | undefined>;
}

const BUCKET_MS = 3600_000;

function bucketKey(kind: UsageKind, dims: UsageDimensions, atMs: number): { key: string; start: number } {
  const start = Math.floor(atMs / BUCKET_MS) * BUCKET_MS;
  return {
    key: [
      kind,
      dims.orgId,
      dims.userId ?? "",
      dims.agentId ?? "",
      dims.serverId ?? "",
      dims.providerName ?? "",
      String(start),
    ].join("|"),
    start,
  };
}

export class InMemoryUsageStore implements UsageStore {
  private readonly seen = new Set<string>();
  private readonly buckets = new Map<string, UsageAggregate>();
  private readonly limits = new Map<string, UsageLimit>();

  async append(event: UsageEvent & { eventId: string }): Promise<boolean> {
    const key = `${event.eventId}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const at = Date.parse(event.at);
    const { key: bucket, start } = bucketKey(event.kind, event.dimensions, at);
    const existing = this.buckets.get(bucket);
    const dims: Partial<UsageDimensions> = {
      orgId: event.dimensions.orgId,
      ...(event.dimensions.userId ? { userId: event.dimensions.userId } : {}),
      ...(event.dimensions.agentId ? { agentId: event.dimensions.agentId } : {}),
      ...(event.dimensions.serverId ? { serverId: event.dimensions.serverId } : {}),
      ...(event.dimensions.providerName ? { providerName: event.dimensions.providerName } : {}),
    };
    if (existing) {
      existing.total += event.quantity;
    } else {
      this.buckets.set(bucket, {
        kind: event.kind,
        dimensions: dims,
        periodStart: new Date(start).toISOString(),
        periodEnd: new Date(start + BUCKET_MS).toISOString(),
        total: event.quantity,
      });
    }
    return true;
  }

  async aggregates(): Promise<UsageAggregate[]> {
    return [...this.buckets.values()];
  }

  async upsertAggregate(aggregate: UsageAggregate): Promise<void> {
    const key = [
      aggregate.kind,
      aggregate.dimensions.orgId ?? "",
      aggregate.periodStart,
    ].join("|");
    this.buckets.set(key, aggregate);
  }

  async upsertLimit(limit: UsageLimit): Promise<void> {
    this.limits.set(`${limit.orgId}:${limit.kind}:${limit.planVersionId}`, limit);
  }

  async getLimit(orgId: string, kind: UsageKind, planVersionId: string): Promise<UsageLimit | undefined> {
    return this.limits.get(`${orgId}:${kind}:${planVersionId}`);
  }
}
