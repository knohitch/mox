/**
 * Cost engine (Prompt 12): separates internal costs from customer pricing.
 *
 * Tracks wholesale provider costs (VPS, setup, storage, backups, IPv4, AI,
 * messaging, voice, payment fees, other infra) and customer revenue, then
 * derives MRR, COGS, gross profit and gross margin by customer/plan/region/
 * provider/time period. Wholesale figures are internal-only; the
 * customer-facing report strips every cost field unless an admin explicitly
 * exposes them.
 */

export type CostCategory =
  | "vps_cost"
  | "setup_fee"
  | "storage"
  | "backups"
  | "ipv4"
  | "ai_cost"
  | "messaging"
  | "voice"
  | "payment_fees"
  | "infra_other";

export interface CostEntry {
  entryId: string;
  category: CostCategory;
  amountMinor: bigint | number;
  currency: string;
  at: string;
  orgId?: string;
  planTier?: string;
  regionCode?: string;
  providerName?: string;
}

export interface RevenueEntry {
  entryId: string;
  /** Monthly recurring component (subscription base price). */
  recurring: boolean;
  amountMinor: bigint | number;
  currency: string;
  at: string;
  orgId?: string;
  planTier?: string;
  regionCode?: string;
}

export type ReportDimension = "org" | "plan" | "region" | "provider";

export interface MarginReportRow {
  key: string;
  currency: string;
  revenueMinor: bigint;
  cogsMinor: bigint;
  grossProfitMinor: bigint;
  grossMarginPct: number;
}

export interface MarginReport {
  currency: string;
  window: { from: string; to: string };
  rows: MarginReportRow[];
  totals: MarginReportRow;
}

export interface CostStore {
  appendCost(entry: CostEntry): Promise<boolean>;
  appendRevenue(entry: RevenueEntry): Promise<boolean>;
  listCosts(): Promise<CostEntry[]>;
  listRevenue(): Promise<RevenueEntry[]>;
}

export class InMemoryCostStore implements CostStore {
  private readonly costsSeen = new Set<string>();
  private readonly revenueSeen = new Set<string>();
  private readonly costs: CostEntry[] = [];
  private readonly revenue: RevenueEntry[] = [];

  async appendCost(entry: CostEntry): Promise<boolean> {
    if (this.costsSeen.has(entry.entryId)) return false;
    this.costsSeen.add(entry.entryId);
    this.costs.push(entry);
    return true;
  }

  async appendRevenue(entry: RevenueEntry): Promise<boolean> {
    if (this.revenueSeen.has(entry.entryId)) return false;
    this.revenueSeen.add(entry.entryId);
    this.revenue.push(entry);
    return true;
  }

  async listCosts(): Promise<CostEntry[]> {
    return [...this.costs];
  }

  async listRevenue(): Promise<RevenueEntry[]> {
    return [...this.revenue];
  }
}
