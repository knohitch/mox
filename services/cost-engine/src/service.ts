import { add, money, type Money } from "@mox/money";
import type { CostEntry, CostStore, MarginReport, MarginReportRow, ReportDimension, RevenueEntry } from "./types.js";
import { InMemoryCostStore } from "./types.js";

export class CostEngine {
  readonly store: CostStore;

  constructor(store: CostStore = new InMemoryCostStore()) {
    this.store = store;
  }

  recordCost(entry: Omit<CostEntry, never> & { entryId: string }): Promise<boolean> {
    return this.store.appendCost(entry as CostEntry);
  }

  recordRevenue(entry: RevenueEntry): Promise<boolean> {
    return this.store.appendRevenue(entry);
  }

  /**
   * MRR = sum of recurring revenue entries in the window (per currency).
   * One-time payments are excluded by definition.
   */
  async mrr(orgId: string | undefined, window: { from: string; to: string }): Promise<Money> {
    const revenue = await this.store.listRevenue();
    let total: Money | undefined;
    for (const entry of revenue) {
      if (!entry.recurring) continue;
      if (orgId && entry.orgId !== orgId) continue;
      if (entry.at <= window.from || entry.at > window.to) continue;
      const amount = money(entry.currency, entry.amountMinor);
      total = total ? add(total, amount) : amount;
    }
    return total ?? money("USD", 0n);
  }

  private inWindow(at: string, window: { from: string; to: string }): boolean {
    return at > window.from && at <= window.to;
  }

  /**
   * Margin report grouped by one dimension. All amounts are normalized into
   * the report currency via explicit conversion rates supplied by the
   * caller — the engine never guesses FX.
   */
  async margin(input: {
    dimension: ReportDimension;
    window: { from: string; to: string };
    currency: string;
    /** FX rate table: source currency → report currency. */
    fxRates: Record<string, number>;
  }): Promise<MarginReport> {
    const keyOf = (entry: { orgId?: string; planTier?: string; regionCode?: string; providerName?: string }): string => {
      switch (input.dimension) {
        case "org":
          return entry.orgId ?? "unassigned";
        case "plan":
          return entry.planTier ?? "unassigned";
        case "region":
          return entry.regionCode ?? "unassigned";
        case "provider":
          return entry.providerName ?? "internal";
      }
    };

    const convert = (amountMinor: bigint | number, currency: string): bigint => {
      if (currency === input.currency) return BigInt(amountMinor);
      const rate = input.fxRates[currency];
      if (!rate) throw new Error(`missing FX rate for ${currency} → ${input.currency}`);
      // Half-up rounding on minor units through integer math.
      const SCALE = 1_000_000n;
      const numerator = BigInt(Math.round(rate * Number(SCALE)));
      const raw = BigInt(amountMinor) * numerator;
      const units = raw / SCALE;
      const rem = raw % SCALE;
      return units + (rem * 2n >= SCALE ? 1n : 0n);
    };

    const rows = new Map<string, MarginReportRow>();
    const emptyRow = (key: string): MarginReportRow => ({
      key,
      currency: input.currency,
      revenueMinor: 0n,
      cogsMinor: 0n,
      grossProfitMinor: 0n,
      grossMarginPct: 0,
    });

    for (const entry of await this.store.listRevenue()) {
      if (!this.inWindow(entry.at, input.window)) continue;
      const rowKey = keyOf(entry);
      const row = rows.get(rowKey) ?? emptyRow(rowKey);
      row.revenueMinor += convert(entry.amountMinor, entry.currency);
      rows.set(rowKey, row);
    }

    for (const entry of await this.store.listCosts()) {
      if (!this.inWindow(entry.at, input.window)) continue;
      const rowKey = keyOf(entry);
      const row = rows.get(rowKey) ?? emptyRow(rowKey);
      row.cogsMinor += convert(entry.amountMinor, entry.currency);
      rows.set(rowKey, row);
    }

    const all = [...rows.values()].map((row) => ({
      ...row,
      grossProfitMinor: row.revenueMinor - row.cogsMinor,
      grossMarginPct:
        row.revenueMinor === 0n ? 0 : Number(((row.revenueMinor - row.cogsMinor) * 10000n) / row.revenueMinor) / 100,
    }));

    const totals = all.reduce<MarginReportRow>(
      (acc, row) => ({
        key: "TOTAL",
        currency: input.currency,
        revenueMinor: acc.revenueMinor + row.revenueMinor,
        cogsMinor: acc.cogsMinor + row.cogsMinor,
        grossProfitMinor: acc.grossProfitMinor + row.grossProfitMinor,
        grossMarginPct: 0,
      }),
      emptyRow("TOTAL"),
    );
    totals.grossMarginPct =
      totals.revenueMinor === 0n
        ? 0
        : Number((totals.grossProfitMinor * 10000n) / totals.revenueMinor) / 100;

    return { currency: input.currency, window: input.window, rows: all.sort((a, b) => a.key.localeCompare(b.key)), totals };
  }
}
