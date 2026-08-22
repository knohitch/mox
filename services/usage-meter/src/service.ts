/**
 * Usage meter service: idempotent ingestion, hourly aggregation and
 * limit evaluation against entitlement-style usage limits.
 */

import type { UsageAggregate, UsageDimensions, UsageEvent, UsageKind, UsageLimit } from "./types.js";
import { InMemoryUsageStore, type UsageStore } from "./types.js";

export type IngestDecision = "accepted" | "duplicate" | "rejected_hard_limit";

export class UsageMeterService {
  readonly store: UsageStore;

  constructor(store: UsageStore = new InMemoryUsageStore()) {
    this.store = store;
  }

  defineLimit(limit: UsageLimit): Promise<void> {
    return this.store.upsertLimit(limit);
  }

  /** Idempotent by caller-supplied event id; enforces hard limits. */
  async ingest(input: { eventId: string } & Omit<UsageEvent, "eventId" | "priceRef">): Promise<IngestDecision> {
    const event: UsageEvent & { eventId: string } = { ...input };
    const limit = await this.store.getLimit(event.dimensions.orgId, event.kind, "*");
    if (limit?.hardLimitQuantity !== undefined && limit.hardLimitQuantity >= 0) {
      const consumed = await this.consumedTotal(event.dimensions.orgId, event.kind);
      if (consumed + event.quantity > limit.hardLimitQuantity) {
        return "rejected_hard_limit";
      }
    }
    const fresh = await this.store.append(event);
    if (!fresh) return "duplicate";
    void limit;
    return "accepted";
  }

  /** Sum of one kind for an org within an optional window. */
  async consumedTotal(
    orgId: string,
    kind: UsageKind,
    window?: { from?: string; to?: string },
  ): Promise<number> {
    const aggregates = await this.store.aggregates();
    let total = 0;
    for (const agg of aggregates) {
      if (agg.kind !== kind || agg.dimensions.orgId !== orgId) continue;
      if (window?.from && agg.periodEnd <= window.from) continue;
      if (window?.to && agg.periodStart >= window.to) continue;
      total += agg.total;
    }
    return total;
  }

  /** Roll hourly buckets up into a period aggregate per (kind, dims). */
  async aggregatePeriod(orgId: string, from: string, to: string): Promise<UsageAggregate[]> {
    const aggregates = await this.store.aggregates();
    const merged = new Map<string, UsageAggregate>();
    for (const agg of aggregates) {
      if (agg.dimensions.orgId !== orgId) continue;
      if (agg.periodEnd <= from || agg.periodStart >= to) continue;
      const key = `${agg.kind}|${JSON.stringify(agg.dimensions)}`;
      const existing = merged.get(key);
      if (existing) existing.total += agg.total;
      else merged.set(key, { ...agg });
    }
    return [...merged.values()];
  }

  /**
   * Limit status: compares consumption with included/soft/hard quantities.
   * Hard limits block; soft limits warn and route to overage pricing.
   */
  async evaluateLimit(input: {
    orgId: string;
    planVersionId: string;
    kind: UsageKind;
  }): Promise<{
    includedQuantity: number;
    consumed: number;
    state: "within_included" | "over_soft" | "over_hard_blocked" | "unlimited";
    overagePriceRef?: string;
  }> {
    const limit = await this.store.getLimit(input.orgId, input.kind, input.planVersionId);
    const consumed = await this.consumedTotal(input.orgId, input.kind);
    const included = limit?.includedQuantity ?? -1;
    if (included < 0 && limit?.hardLimitQuantity === undefined) {
      return { includedQuantity: -1, consumed, state: "unlimited" };
    }
    if (limit?.hardLimitQuantity !== undefined && consumed > limit.hardLimitQuantity) {
      return {
        includedQuantity: included,
        consumed,
        state: "over_hard_blocked",
        overagePriceRef: limit.overagePriceRef,
      };
    }
    if (limit?.softLimitQuantity !== undefined && consumed > limit.softLimitQuantity) {
      return {
        includedQuantity: included,
        consumed,
        state: "over_soft",
        overagePriceRef: limit.overagePriceRef,
      };
    }
    return { includedQuantity: included, consumed, state: "within_included", overagePriceRef: limit?.overagePriceRef };
  }

  dimensionsFor(dims: UsageDimensions): UsageDimensions {
    return dims;
  }
}
