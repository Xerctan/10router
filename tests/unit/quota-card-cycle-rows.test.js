/**
 * Quota card cycle-row classification.
 *
 * The usage card renders cycle windows in a fixed order — 滚动 → 月度 → 每周 —
 * each as its own two-line block (label + numbers, then a full-width bar). The
 * monthly slot stays in place as a 0% placeholder when the account has no
 * monthly window, so a reader can tell "no monthly allowance" apart from "the
 * row vanished".
 *
 * `classifyCycleRows` is the pure decision behind that layout, extracted from
 * QuotaPackBar so it can be tested without a DOM (this suite runs under
 * `environment: "node"` — there is no jsdom/react here, and no other test
 * renders this component).
 *
 * These payloads are the real shapes the upstream fetchers produce.
 */

import { describe, it, expect } from "vitest";
import {
  classifyCycleRows,
  isStoredValueRow,
  isRecurringQuotaRow,
  quotaUnitOf,
} from "../../src/shared/utils/quotaRows.js";

const row = (name, extra = {}) => ({ name, used: 0, total: 100, ...extra });

describe("isStoredValueRow", () => {
  it("flags balance / voucher / cash rows in both languages", () => {
    expect(isStoredValueRow(row("Balance (CNY)"))).toBe(true);
    expect(isStoredValueRow(row("Voucher (CNY)"))).toBe(true);
    expect(isStoredValueRow(row("Cash (USD)"))).toBe(true);
    expect(isStoredValueRow(row("余额 (CNY)"))).toBe(true);
    expect(isStoredValueRow(row("代金券 (CNY)"))).toBe(true);
  });

  it("does not flag cycle or pack rows", () => {
    expect(isStoredValueRow(row("Weekly"))).toBe(false);
    expect(isStoredValueRow(row("Monthly"))).toBe(false);
    expect(isStoredValueRow(row("Bonus Pack 21"))).toBe(false);
  });
});

describe("quotaUnitOf", () => {
  it("lifts the trailing parenthetical off the name", () => {
    expect(quotaUnitOf("Balance (CNY)")).toBe("CNY");
    expect(quotaUnitOf("Voucher (USD)")).toBe("USD");
    expect(quotaUnitOf("余额 (CNY)")).toBe("CNY");
  });

  it("returns empty when there is no unit", () => {
    expect(quotaUnitOf("Weekly")).toBe("");
    expect(quotaUnitOf("Bonus Pack 21")).toBe("");
  });
});

describe("classifyCycleRows", () => {
  it("mimo-desktop: a bare Weekly row is recognised without a recurring flag", () => {
    // mimo-desktop falls through parseQuotaData's `default` branch and carries
    // NO `recurring` field — only its name. (Real payload: {"Weekly": {...}})
    const weekly = row("Weekly", { resetAt: "2026-10-06T08:43:49.000Z" });
    expect(isRecurringQuotaRow(weekly)).toBe(true);

    const c = classifyCycleRows([weekly]);
    expect(c.hasAnyCycle).toBe(true);
    expect(c.weekly).toBe(weekly);
    expect(c.rolling).toBe(null);
    expect(c.monthly).toBe(null);
    // No monthly on this account → the slot must still render, as 0%.
    expect(c.monthlyPlaceholder).toBe(true);
  });

  it("orders rolling before monthly before weekly, keeping each slot separate", () => {
    const rolling = row("session (5h)", { recurring: true });
    const monthly = row("Monthly", { recurring: true });
    const weekly = row("Weekly", { recurring: true });

    const c = classifyCycleRows([weekly, monthly, rolling]);
    expect(c.rolling).toBe(rolling);
    expect(c.monthly).toBe(monthly);
    expect(c.weekly).toBe(weekly);
    expect(c.monthlyPlaceholder).toBe(false);
  });

  it("a row named Monthly can never also be picked up as weekly", () => {
    const monthly = row("Monthly", { recurring: true });
    const c = classifyCycleRows([monthly]);
    expect(c.monthly).toBe(monthly);
    expect(c.weekly).toBe(null);
  });

  it("collapses to at most one row per slot (never stacks two 每周 blocks)", () => {
    const w1 = row("Weekly", { recurring: true });
    const w2 = row("weekly (7d)", { recurring: true });
    const c = classifyCycleRows([w1, w2]);
    expect(c.weekly).toBe(w1);
    // The extra row is not silently dropped — it still renders.
    expect(c.unmatched).toEqual([w2]);
  });

  it("stored-value rows are NOT cycle rows (stepfun-cn has no cycles at all)", () => {
    // Real payload: {"Balance (CNY)": {…}, "Voucher (CNY)": {…}} — both
    // displayRemaining with no recurring flag.
    const c = classifyCycleRows([
      row("Balance (CNY)", { displayRemaining: true }),
      row("Voucher (CNY)", { displayRemaining: true }),
    ]);
    expect(c.hasAnyCycle).toBe(false);
    // Pure stored-value card → no synthetic monthly 0% placeholder.
    expect(c.monthlyPlaceholder).toBe(false);
    expect(c.rolling).toBe(null);
    expect(c.weekly).toBe(null);
    expect(c.monthly).toBe(null);
  });

  it("codebuddy-cn: Monthly joins cycles while Bonus Packs stay non-recurring", () => {
    // Real payload: Monthly recurring=true; Bonus Pack N recurring=false.
    const monthly = row("Monthly", { recurring: true, total: 500, used: 500 });
    const pack = row("Bonus Pack 21", { recurring: false, total: 100, used: 44.67 });
    const total = row("Total Points", { recurring: false, total: 4182, used: 2726.67 });

    const c = classifyCycleRows([total, monthly, pack]);
    expect(c.monthly).toBe(monthly);
    expect(c.monthlyPlaceholder).toBe(false);
    // The pack family and the aggregate must not be swept into the cycle slots.
    expect(c.unmatched).toEqual([]);
    expect(c.rolling).toBe(null);
    expect(c.weekly).toBe(null);
  });

  it("an unrecognised recurring row still surfaces instead of vanishing", () => {
    const odd = row("something window", { recurring: true });
    const c = classifyCycleRows([odd]);
    expect(c.hasAnyCycle).toBe(true);
    expect(c.unmatched).toEqual([odd]);
  });
});
