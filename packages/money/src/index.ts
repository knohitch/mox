/**
 * Mox money: integer minor-unit arithmetic with explicit currencies.
 *
 * Rules (Prompt 08):
 * - Never use floating point for money. Amounts are integers in the
 *   currency's minor unit (e.g. cents, pesewas, kobo).
 * - Every amount carries its ISO-4217 currency code.
 * - Currency registry is extensible; USD/GBP/NGN/GHS ship by default.
 * - FX conversion rounds half-up on minor units and never mutates inputs.
 */

const MAX_SAFE_MINOR = 9007199254740991n;

export interface Money {
  readonly currency: string;
  readonly amountMinor: bigint;
}

export interface CurrencyDefinition {
  /** ISO-4217 alphabetic code. */
  readonly code: string;
  /** Minor units per major unit (2 for USD/GBP/NGN/GHS, 0 for e.g. JPY). */
  readonly exponent: number;
  readonly displayName: string;
}

const registry = new Map<string, CurrencyDefinition>();

function registerCurrency(def: CurrencyDefinition): void {
  if (!/^[A-Z]{3}$/.test(def.code)) {
    throw new Error(`invalid currency code: ${def.code}`);
  }
  if (!Number.isInteger(def.exponent) || def.exponent < 0 || def.exponent > 4) {
    throw new Error(`invalid currency exponent for ${def.code}: ${def.exponent}`);
  }
  registry.set(def.code, def);
}

registerCurrency({ code: "USD", exponent: 2, displayName: "US Dollar" });
registerCurrency({ code: "GBP", exponent: 2, displayName: "Pound Sterling" });
registerCurrency({ code: "NGN", exponent: 2, displayName: "Nigerian Naira" });
registerCurrency({ code: "GHS", exponent: 2, displayName: "Ghanaian Cedi" });

/** Register or replace a currency definition (extensible ISO handling). */
export function registerCurrencyDefinition(def: CurrencyDefinition): void {
  registerCurrency(def);
}

export function getCurrency(code: string): CurrencyDefinition | undefined {
  return registry.get(code);
}

export function listCurrencies(): CurrencyDefinition[] {
  return [...registry.values()];
}

export function isSupportedCurrency(code: string): boolean {
  return registry.has(code);
}

function assertAmount(amountMinor: bigint): void {
  if (amountMinor > MAX_SAFE_MINOR || amountMinor < -MAX_SAFE_MINOR) {
    throw new Error("money amount outside safe range");
  }
}

export function money(currency: string, amountMinor: bigint | number): Money {
  if (!isSupportedCurrency(currency)) {
    throw new Error(`unsupported currency: ${currency}`);
  }
  const amount = typeof amountMinor === "number" ? BigInt(Math.trunc(amountMinor)) : amountMinor;
  if (typeof amountMinor === "number" && !Number.isInteger(amountMinor)) {
    throw new Error(`money amount must be an integer number of minor units: ${amountMinor}`);
  }
  assertAmount(amount);
  return { currency, amountMinor: amount };
}

export function zero(currency: string): Money {
  return money(currency, 0n);
}

export function add(a: Money, b: Money): Money {
  requireSameCurrency(a, b);
  const sum = a.amountMinor + b.amountMinor;
  assertAmount(sum);
  return { currency: a.currency, amountMinor: sum };
}

export function subtract(a: Money, b: Money): Money {
  requireSameCurrency(a, b);
  const diff = a.amountMinor - b.amountMinor;
  assertAmount(diff);
  return { currency: a.currency, amountMinor: diff };
}

export function compare(a: Money, b: Money): number {
  requireSameCurrency(a, b);
  return a.amountMinor === b.amountMinor ? 0 : a.amountMinor < b.amountMinor ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return compare(a, b) === 0;
}

/** Scale by a factor with half-up rounding on minor units (proration etc.). */
export function scale(a: Money, factor: number): Money {
  if (!Number.isFinite(factor)) throw new Error("scale factor must be finite");
  const SCALE = 1_000_000_000n;
  const numerator = BigInt(Math.round(factor * Number(SCALE)));
  const raw = a.amountMinor * numerator;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  let units = abs / SCALE;
  const remainder = abs % SCALE;
  if (remainder * 2n >= SCALE) units += 1n;
  const result = negative ? -units : units;
  assertAmount(result);
  return { currency: a.currency, amountMinor: result };
}

function requireSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

/**
 * Convert between currencies using an explicit FX rate.
 * Rounds half-up on minor units; the rate is expressed as
 * minor units of `to` per minor unit of `from`.
 */
export function convert(from: Money, toCurrency: string, rate: number): Money {
  if (!isSupportedCurrency(toCurrency)) {
    throw new Error(`unsupported currency: ${toCurrency}`);
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`invalid fx rate: ${rate}`);
  }
  // Exact integer path: amount * numerator / denominator with rounding half-up.
  const SCALE = 1_000_000_000n;
  const numerator = BigInt(Math.round(rate * Number(SCALE)));
  const raw = from.amountMinor * numerator;
  const NEG = raw < 0n;
  const abs = NEG ? -raw : raw;
  let units = abs / SCALE;
  const remainder = abs % SCALE;
  if (remainder * 2n >= SCALE) units += 1n;
  const result = NEG ? -units : units;
  assertAmount(result);
  return { currency: toCurrency, amountMinor: result };
}

/** Major-unit string like "12.50"; used only for display, never storage. */
export function format(value: Money): string {
  const def = getCurrency(value.currency);
  const exp = def ? BigInt(10 ** def.exponent) : 1n;
  const negative = value.amountMinor < 0n;
  const abs = negative ? -value.amountMinor : value.amountMinor;
  const major = abs / exp;
  const minor = abs % exp;
  const minorStr = def && def.exponent > 0 ? minor.toString().padStart(def.exponent, "0") : "";
  return `${negative ? "-" : ""}${major.toString()}${minorStr ? "." + minorStr : ""}`;
}
