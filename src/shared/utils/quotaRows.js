/**
 * Quota row classification — pure, DOM-free, JSX-free.
 *
 * Split out of `QuotaPackBar.js` so it can be unit-tested directly: the card
 * component is a `.js` file full of JSX, which this suite's vite pipeline
 * cannot import (no React plugin, and the test runner is `environment: "node"`
 * with no jsdom). Keeping the decisions here also makes the layout rules
 * readable on their own, away from the markup.
 */

export const AGGREGATE_RE = /total|aggregate|summary|^总/i;
export const MONTHLY_RE = /month|月/i;
export const WEEKLY_RE = /week|周/i;
export const ROLLING_RE = /rolling|滚动|session|5h/i;
export const RECURRING_NAME_RE = /month|月|week|周|滚动|rolling/i;
// Stored-value pools (余额/代金券/现金…): a settled balance, not a window. They
// always read X/X because nothing decrements `total`, so the "/ total" half is
// noise — these render as a single value + unit.
export const STORED_VALUE_RE = /balance|voucher|cash|余额|代金券|现金/i;

/** Aggregate/summary rows are derived data — never charted, never summed. */
export function isAggregateQuotaRow(row) {
  return AGGREGATE_RE.test(String(row?.name || ""));
}

/** Subscription-recurring window: explicit flag or a cycle-named row. */
export function isRecurringQuotaRow(row) {
  if (row?.recurring === true) return true;
  return RECURRING_NAME_RE.test(String(row?.name || ""));
}

/** Stored-value pool (余额/代金券/现金): renders as one value, never "X / Y". */
export function isStoredValueRow(row) {
  return STORED_VALUE_RE.test(String(row?.name || ""));
}

/**
 * `"Balance (CNY)"` → `"CNY"`; `"Weekly"` → `""`.
 * The stored-value unit is lifted out of the row name so it can be re-attached
 * to the number as small print instead of living in the label.
 */
export function quotaUnitOf(name) {
  const m = /\(([^)]+)\)\s*$/.exec(String(name || ""));
  return m ? m[1].trim() : "";
}

/** Name with any trailing `(...)` unit stripped: `"Balance (CNY)"` → `"Balance"`. */
export function nameWithoutUnit(name) {
  return String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Fixed cycle order for the card: 滚动 → 月度 → 每周. Each entry is one
 * "item block" (its own header line + its own bar), all always present in the
 * same order so cards scan consistently.
 *
 * The monthly slot ALWAYS renders once the card has any cycle row at all: when
 * the account has no monthly window it shows as `0%` rather than vanishing, so
 * the reader can tell "no monthly allowance" from "monthly row missing".
 * A card with no cycle rows at all (pure stored-value, e.g. stepfun) gets no
 * synthetic monthly placeholder.
 *
 * `rolling` and `weekly` each collapse to at most one row (first match wins) —
 * a card never stacks two 每周 blocks.
 */
export function classifyCycleRows(rows = []) {
  const cycleRows = rows.filter((r) => isRecurringQuotaRow(r) && !isStoredValueRow(r));

  // Monthly is detected first and removed from the pool so a row named e.g.
  // "Monthly" can never also be picked up as weekly/rolling.
  const monthly = cycleRows.find((r) => MONTHLY_RE.test(String(r.name || ""))) || null;
  const rest = cycleRows.filter((r) => r !== monthly);

  const rolling = rest.find((r) => ROLLING_RE.test(String(r.name || ""))) || null;
  const weekly =
    rest.find((r) => r !== rolling && WEEKLY_RE.test(String(r.name || ""))) || null;

  return {
    hasAnyCycle: cycleRows.length > 0,
    rolling,
    monthly,
    weekly,
    monthlyPlaceholder: cycleRows.length > 0 && !monthly,
    // Rows that matched *no* cycle bucket (e.g. a recurring flag on a row with
    // an unrecognised name) still get rendered so nothing silently disappears.
    unmatched: rest.filter((r) => r !== rolling && r !== weekly),
  };
}
