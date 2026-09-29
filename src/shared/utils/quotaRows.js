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
// A cycle WINDOW. Must cover every spelling the fetchers emit, because the
// `recurring` flag is not always forwarded (antigravity carries only
// `percentScale`, mimo-desktop only a name):
//   session (5h) / weekly (7d) / Monthly Credits   — commandcode, codebuddy
//   Weekly                                         — mimo-desktop
//   <family> · 5h Window / · Weekly Window         — antigravity
// Missing `5h`/`window` here made antigravity's 5h row classify as
// non-recurring, so it was silently dropped from the card.
export const RECURRING_NAME_RE = /month|月|week|周|滚动|rolling|5h|hourly|window/i;
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

/**
 * Name with any trailing `(...)` unit stripped: `"Balance (CNY)"` → `"Balance"`.
 *
 * ONLY for stored-value rows. Do NOT run this on cycle rows: the parenthetical
 * is part of the dictionary key there (`"session (5h)"` → 滚动, `"weekly (7d)"`
 * → 每周), so stripping it makes the lookup miss and the card renders the raw
 * English name. That was a real regression — see `quota-card-cycle-rows.test.js`.
 */
export function nameWithoutUnit(name) {
  return String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** remaining/total clamped to 0–100, tolerant of missing/zero totals. */
export function percentOf(row) {
  const total = Number((row?.totalNum ?? row?.total) || 0);
  const remaining = Number.isFinite(row?.remainingNum)
    ? Number(row.remainingNum)
    : Math.max(0, total - Number(row?.used || 0));
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (remaining / total) * 100));
}

const CYCLE_LAYER_RE = {
  monthly: /month|月|credit/i,
  weekly: /week|周/i,
  rolling: /rolling|滚动|session|5h/i,
};

/**
 * Build the nested cycle ladder — outermost (largest allowance) first.
 *
 * WHICH rows nest (this is the whole subtlety):
 *
 *  - commandcode: `session (5h)` ⊂ `weekly (7d)` ⊂ `Monthly Credits` — three
 *    scopes of the SAME resource, each a hard ceiling on the one inside it. A
 *    month's credits are doled out into weeks, which are doled out into 5h
 *    sessions. That is a true containment chain.
 *
 *  - antigravity: `Gemini · 5h Window` + `Gemini · Weekly Window` — two
 *    SEPARATE windows on the same family. Neither contains the other; both are
 *    independent meters that happen to share a name prefix. These must render
 *    as two side-by-side bars, NOT as a ladder.
 *
 * So nesting requires a MONTHLY head. Without one there is no containment chain
 * to draw — only parallel windows — and this returns `[]`, leaving the caller to
 * render each row as its own plain full-width bar (which is exactly the
 * antigravity shape).
 *
 * When nesting IS in play, each layer's bar is scaled against its PARENT's
 * total, so the ladder narrows monotonically outward→inner:
 *
 *   月度额度  [████████████████████]  full-width measure
 *     每周    [██████████████      ]  weekly/months
 *       滚动  [██████              ]  session/weekly
 *
 * Why the parent's total and not the outermost: the layers count different
 * things (sessions vs credits), so `remaining / outerTotal` only looks right
 * when the numbers happen to align. Comparing a layer to ITS OWN parent is the
 * relationship the data actually expresses, and it is what guarantees a child
 * never overhangs its parent.
 *
 * Each row still reports its OWN `X / Y` in the label — the ladder shares only
 * the measure, not the ceiling.
 */
export function buildNestedCycle(rows = []) {
  const buckets = { monthly: null, weekly: null, rolling: null };
  for (const row of rows) {
    const name = String(row?.name || "");
    for (const [layer, re] of Object.entries(CYCLE_LAYER_RE)) {
      if (!buckets[layer] && re.test(name)) {
        buckets[layer] = row;
        break;
      }
    }
  }

  // No monthly head → no containment chain. Parallel windows (antigravity's
  // 5h + weekly) stay independent.
  if (!buckets.monthly) return [];

  const ladder = [buckets.monthly, buckets.weekly, buckets.rolling].filter(Boolean);

  /** remaining/total in the row's OWN unit, 0–100 (0 when the unit is unknown). */
  const shareOfSelf = (row) => {
    const total = Number((row.totalNum ?? row.total) || 0);
    if (total <= 0) return 0;
    const remaining = Number.isFinite(row.remainingNum)
      ? Number(row.remainingNum)
      : Math.max(0, total - Number(row.used || 0));
    return Math.min(100, Math.max(0, (remaining / total) * 100));
  };

  return ladder.map((row, depth) => {
    const ownTotal = Number((row.totalNum ?? row.total) || 0);
    const ownRemaining = Number.isFinite(row.remainingNum)
      ? Number(row.remainingNum)
      : Math.max(0, ownTotal - Number(row.used || 0));

    // Depth 0 is the measure bar. Each child occupies `parentPct × own share`
    // of the full track, nested inside its parent's span — never beside it.
    let widthPct = 100;
    for (let i = 1; i <= depth; i += 1) {
      widthPct = (widthPct * shareOfSelf(ladder[i])) / 100;
    }

    return { row, depth, widthPct, ownRemaining, ownTotal, ownPct: shareOfSelf(row) };
  });
}

/**
 * Cycle rows that are NOT part of the nested ladder and NOT monthly packs.
 *
 * A `Monthly` / `Monthly Credits` row is a RESOURCE PACK expiring at month end
 * (codebuddy, qoder), not a window — it belongs in the additive pool bar, so it
 * is deliberately excluded here and never gets its own card block.
 *
 * Returning nothing for a card with no such rows is correct: a stored-value card
 * (stepfun) and a purely-monthly card both render no cycle block, and nothing
 * synthetic is invented for them.
 */
export function classifyCycleRows(rows = []) {
  const cycleRows = rows.filter((r) => isRecurringQuotaRow(r) && !isStoredValueRow(r));
  const monthly = cycleRows.filter((r) => MONTHLY_RE.test(String(r.name || "")));
  const windows = cycleRows.filter((r) => !monthly.includes(r));

  return {
    hasAnyCycle: windows.length > 0,
    /** Rolling / weekly (and anything else recurring that isn't a monthly pack). */
    windows,
    /** Monthly resource packs — fed to the pool bar, never a card block. */
    monthly,
  };
}
