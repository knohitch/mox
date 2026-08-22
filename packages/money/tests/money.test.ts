import { describe, expect, it } from "vitest";
import {
  add,
  compare,
  convert,
  equals,
  format,
  getCurrency,
  isSupportedCurrency,
  money,
  registerCurrencyDefinition,
  scale,
  subtract,
} from "../src/index.js";

describe("money", () => {
  it("stores amounts as integer minor units without float drift", () => {
    // 0.10 + 0.20 in floats is 0.30000000000000004; minor units stay exact.
    const a = money("USD", 10n);
    const b = money("USD", 20n);
    expect(format(add(a, b))).toBe("0.30");
  });

  it("rejects fractional minor units", () => {
    expect(() => money("USD", 1.5)).toThrow();
  });

  it("rejects unsupported currencies until registered", () => {
    expect(isSupportedCurrency("XYZ")).toBe(false);
    expect(() => money("XYZ", 1n)).toThrow();
    registerCurrencyDefinition({ code: "XYZ", exponent: 2, displayName: "Test" });
    expect(isSupportedCurrency("XYZ")).toBe(true);
    expect(getCurrency("XYZ")?.exponent).toBe(2);
  });

  it("ships USD GBP NGN GHS with exponent 2", () => {
    for (const code of ["USD", "GBP", "NGN", "GHS"]) {
      expect(getCurrency(code)?.exponent).toBe(2);
    }
  });

  it("adds subtracts compares only within the same currency", () => {
    const usd = money("USD", 500n);
    const ghs = money("GHS", 500n);
    expect(() => add(usd, ghs)).toThrow(/mismatch/);
    expect(() => compare(usd, ghs)).toThrow();
    expect(add(usd, money("USD", 250n)).amountMinor).toBe(750n);
    expect(subtract(usd, money("USD", 100n)).amountMinor).toBe(400n);
    expect(compare(money("USD", 1n), money("USD", 2n))).toBe(-1);
    expect(equals(money("NGN", 7n), money("NGN", 7n))).toBe(true);
  });

  it("converts across currencies with half-up rounding on minor units", () => {
    // 199.99 USD at 1550.123 NGN/USD -> 31000910 kobo exactly.
    const usd = money("USD", 199_99n);
    const ngn = convert(usd, "NGN", 1550.123);
    expect(ngn.currency).toBe("NGN");
    expect(ngn.amountMinor).toBe(31_000_910n);
    // Half-up check: 0.5005 minor units rounds up to 1; 0.4995 stays 0.
    const tiny = convert(money("USD", 1n), "GBP", 0.5005);
    expect(tiny.amountMinor).toBe(1n);
    const down = convert(money("USD", 1n), "GBP", 0.4995);
    expect(down.amountMinor).toBe(0n);
  });

  it("scales by percentage-style factors exactly enough for proration", () => {
    const monthly = money("USD", 2999n);
    const half = scale(monthly, 0.5);
    expect(half.amountMinor).toBe(1500n); // 1499.5 -> 1500 (half-up)
  });

  it("formats major.minor display strings", () => {
    expect(format(money("GHS", 120500n))).toBe("1205.00");
    expect(format(money("GBP", 9n))).toBe("0.09");
    expect(format(money("USD", -2500n))).toBe("-25.00");
  });
});
