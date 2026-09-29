/**
 * Quota card cycle rows + nested ladder.
 *
 * Two behaviors the card depends on, both pure and DOM-free (this suite is
 * `environment: "node"`, and QuotaPackBar is a JSX .js file vite cannot import
 * here — no React plugin, no jsdom):
 *
 *  1. `classifyCycleRows` — which rows are cycle WINDOWS (滚动/每周) versus
 *     monthly RESOURCE PACKS (codebuddy / qoder's `Monthly`, which expire at
 *     month end and belong in the additive pool bar, not a card block).
 *  2. `buildNestedCycle` — the 月度 ⊃ 每周 ⊃ 滚动 ladder. These allowances
 *     genuinely nest on commandcode (3 ⊂ 6 ⊂ 10), so each layer's bar is
 *     measured against the OUTERMOST total. That is what makes
 *     "rolling ≤ weekly ≤ monthly" structural instead of something the renderer
 *     polices.
 *
 * Payloads below are the real upstream shapes.
 */

import { describe, it, expect } from "vitest";
import {
  buildNestedCycle,
  classifyCycleRows,
  isRecurringQuotaRow,
  isStoredValueRow,
  nameWithoutUnit,
  percentOf,
  quotaUnitOf,
} from "../../src/shared/utils/quotaRows.js";

const row = (name, extra = {}) => ({ name, used: 0, total: 100, ...extra });

describe("nameWithoutUnit / quotaUnitOf (the card-name regression)", () => {
  it("strips the unit for stored-value rows", () => {
    expect(nameWithoutUnit("Balance (CNY)")).toBe("Balance");
    expect(quotaUnitOf("Balance (CNY)")).toBe("CNY");
  });

  it("MUST NOT be applied to cycle rows — the suffix is the dictionary key", () => {
    // Regression guard for the bug this function shipped with. The dictionary
    // keys are the FULL names:
    //   "session (5h)" → 滚动, "weekly (7d)" → 每周, "Monthly Credits" → 月度额度
    // Stripping the parenthetical yields "session" / "weekly", which are NOT
    // keys, so translateQuotaName fell through and the card rendered the raw
    // English name while the detail table showed 滚动/每周.
    expect(nameWithoutUnit("session (5h)")).toBe("session");
    expect(nameWithoutUnit("weekly (7d)")).toBe("weekly");
    // Only the stored-value path may strip, and it is keyed on the row, not on
    // the name shape — so these names must reach the lookup intact.
    expect(isStoredValueRow(row("session (5h)", { recurring: true }))).toBe(false);
    expect(isStoredValueRow(row("weekly (7d)", { recurring: true }))).toBe(false);
    expect(isStoredValueRow(row("Monthly Credits", { recurring: true }))).toBe(false);
  });
});

describe("classifyCycleRows", () => {
  it("treats Monthly as a resource pack, not a cycle window", () => {
    const monthly = row("Monthly Credits", { recurring: true, total: 10, used: 0.04 });
    const c = classifyCycleRows([monthly]);
    expect(c.monthly).toEqual([monthly]);
    // No windows → the card renders no cycle block at all.
    expect(c.hasAnyCycle).toBe(false);
    expect(c.windows).toEqual([]);
  });

  it("keeps rolling/weekly as windows and excludes the monthly pack", () => {
    const session = row("session (5h)", { recurring: true, total: 3 });
    const weekly = row("weekly (7d)", { recurring: true, total: 6 });
    const monthly = row("Monthly Credits", { recurring: true, total: 10 });

    const c = classifyCycleRows([session, weekly, monthly]);
    expect(c.hasAnyCycle).toBe(true);
    expect(c.windows).toEqual([session, weekly]);
    expect(c.monthly).toEqual([monthly]);
  });

  it("mimo-desktop: a lone Weekly is a window with no monthly invented", () => {
    // Real payload: {"Weekly": {...}} — no recurring flag (default branch
    // provider), so recognition is by name.
    const weekly = row("Weekly", { resetAt: "2026-10-06T08:43:49.000Z" });
    expect(isRecurringQuotaRow(weekly)).toBe(true);

    const c = classifyCycleRows([weekly]);
    expect(c.windows).toEqual([weekly]);
    // The old 0% "Monthly" placeholder is gone — nothing synthetic is added.
    expect(c.monthly).toEqual([]);
  });

  it("a pure stored-value card has no cycle rows at all (stepfun-cn)", () => {
    const c = classifyCycleRows([
      row("Balance (CNY)", { displayRemaining: true, total: 14.95 }),
      row("Voucher (CNY)", { displayRemaining: true, total: 14.95 }),
    ]);
    expect(c.hasAnyCycle).toBe(false);
    expect(c.windows).toEqual([]);
    expect(c.monthly).toEqual([]);
  });
});

describe("buildNestedCycle", () => {
  // Real commandcode payload.
  const session = row("session (5h)", { recurring: true, total: 3, used: 0, remaining: 3, remainingNum: 3 });
  const weekly = row("weekly (7d)", { recurring: true, total: 6, used: 0.0365, remaining: 5.9635, remainingNum: 5.9635 });
  const monthly = row("Monthly Credits", { recurring: true, total: 10, used: 0.0365, remaining: 9.9635, remainingNum: 9.9635 });

  it("orders outermost-first: 月度 ⊃ 每周 ⊃ 滚动", () => {
    const ladder = buildNestedCycle([session, weekly, monthly]);
    expect(ladder.map((l) => l.row.name)).toEqual([
      "Monthly Credits",
      "weekly (7d)",
      "session (5h)",
    ]);
    expect(ladder.map((l) => l.depth)).toEqual([0, 1, 2]);
  });

  it("nests each layer inside its parent, monotonically narrowing", () => {
    const ladder = buildNestedCycle([session, weekly, monthly]);
    const [m, w, s] = ladder;
    const weeklyShare = (5.9635 / 6) * 100; // ~99.39% of the month
    expect(m.widthPct).toBe(100);           // measure bar
    expect(w.widthPct).toBeCloseTo(weeklyShare, 3);
    // session is full (3/3), so it fills the weekly span — which is itself
    // inset in the month. Widths compound down the ladder.
    expect(s.widthPct).toBeCloseTo(weeklyShare, 3);
    // The invariant the layout rests on: nested spans never overhang.
    expect(s.widthPct).toBeLessThanOrEqual(w.widthPct);
    expect(w.widthPct).toBeLessThanOrEqual(m.widthPct);
  });

  it("each layer keeps its OWN ceiling in the label (X / own-total)", () => {
    const [m, w, s] = buildNestedCycle([session, weekly, monthly]);
    expect([m.ownRemaining, m.ownTotal]).toEqual([9.9635, 10]);
    expect([w.ownRemaining, w.ownTotal]).toEqual([5.9635, 6]);
    expect([s.ownRemaining, s.ownTotal]).toEqual([3, 3]);
  });

  it("keeps a depleted parent wider than a full child (nesting by TYPE)", () => {
    // The nesting is structural, not value-based: a 100%-of-itself session must
    // still sit INSIDE a 10%-of-itself weekly, because session is carved out of
    // weekly. Scaling by each layer's own share of its parent guarantees it —
    // scaling by absolute remaining/outerTotal did not (it compared a session
    // request count against a monthly credit total, which only looked right
    // while the live numbers happened to line up).
    const tightWeekly = row("weekly (7d)", { recurring: true, total: 6, remaining: 0.6, remainingNum: 0.6 });
    const fullSession = row("session (5h)", { recurring: true, total: 3, remaining: 3, remainingNum: 3 });
    const ladder = buildNestedCycle([tightWeekly, fullSession, monthly]);
    expect(ladder.map((l) => l.row.name)).toEqual(["Monthly Credits", "weekly (7d)", "session (5h)"]);
    const [, w, s] = ladder;
    expect(w.widthPct).toBeCloseTo(10, 3);   // 0.6 / 6
    expect(s.widthPct).toBeCloseTo(10, 3);   // 100% of that weekly span
    expect(s.widthPct).toBeLessThanOrEqual(w.widthPct);
  });

  it("a lone weekly is NOT a ladder — it renders as one plain flat bar", () => {
    // mimo: only a Weekly, no monthly. No containment chain exists, so there is
    // nothing to nest; the renderer draws a single full-width bar instead.
    const weekly2 = row("Weekly", { recurring: true, total: 100, remaining: 100, remainingNum: 100 });
    expect(buildNestedCycle([weekly2])).toEqual([]);
  });

  it("weekly + rolling without a monthly head stay flat (nothing to contain them)", () => {
    // A weekly/rolling pair only nests when a monthly allowance is the thing
    // they are carved out of. Absent that, they are parallel windows.
    expect(buildNestedCycle([session, weekly])).toEqual([]);
  });

  it("returns empty for no cycle rows, so a plain card renders no ladder", () => {
    expect(buildNestedCycle([])).toEqual([]);
    expect(buildNestedCycle([row("Bonus Pack 21"), row("Balance (CNY)")])).toEqual([]);
  });

  it("antigravity: 5h + weekly are PARALLEL windows, never a ladder", () => {
    // Real shape: `familyDisplayName · windowLabel`, e.g.
    //   "Gemini · 5h Window"   {percentScale:true, total:100}
    //   "Gemini · Weekly Window"
    // Neither contains the other — they are two independent meters on the same
    // family. With no monthly head there is no containment chain, so this must
    // stay flat (the renderer then draws two side-by-side full-width bars).
    const fiveH = row("Gemini · 5h Window", { percentScale: true, total: 100, remainingNum: 72, remainingPercentage: 72 });
    const weeklyWin = row("Gemini · Weekly Window", { percentScale: true, total: 100, remainingNum: 41, remainingPercentage: 41 });

    const ladder = buildNestedCycle([fiveH, weeklyWin]);
    expect(ladder).toEqual([]);

    // ...and they still show up as cycle windows so the caller renders them.
    const c = classifyCycleRows([fiveH, weeklyWin]);
    expect(c.hasAnyCycle).toBe(true);
    expect(c.windows).toHaveLength(2);
    expect(new Set(c.windows.map((r) => r.name))).toEqual(
      new Set(["Gemini · 5h Window", "Gemini · Weekly Window"]),
    );
    // A "5h Window" is not the same thing as a monthly pack, and must not be
    // swept into the pool.
    expect(c.monthly).toEqual([]);
  });

  it("antigravity weekly ALONE also stays flat (no fabricated parent)", () => {
    const weeklyWin = row("Claude · Weekly Window", { percentScale: true, total: 100, remainingNum: 41 });
    expect(buildNestedCycle([weeklyWin])).toEqual([]);
  });
});

describe("percentOf", () => {
  it("clamps to 0–100 and tolerates a missing/zero total", () => {
    expect(percentOf({ totalNum: 10, remainingNum: 5 })).toBe(50);
    expect(percentOf({ totalNum: 10, remainingNum: 20 })).toBe(100);
    expect(percentOf({ totalNum: 10, remainingNum: 0 })).toBe(0);
    expect(percentOf({ totalNum: 0, remainingNum: 0 })).toBe(0);
    expect(percentOf({ total: 4, used: 1 })).toBe(75);
  });
});
