"use client";

import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { translateQuotaName } from "@/shared/utils/quotaName";
import {
  buildNestedCycle,
  classifyCycleRows,
  cycleRowLines,
  isAggregateQuotaRow,
  isRecurringQuotaRow,
  isStoredValueRow,
  nameWithoutUnit,
  percentOf,
  quotaUnitOf,
} from "@/shared/utils/quotaRows";
import { cn } from "@/shared/utils/cn";

/**
 * Connection quota block — CreditDaddy account-card language (签到积分型).
 *
 * Aggregate half (additive pool only):
 *
 *   [✦✦] 2,455.33                    2,455.33 / 4,182
 *   [family: proportional segments | trailing used chunk]   ← 月度并入：
 *     它就是「以重置日为到期日的资源包」，不再单独成行
 *   15 个资源包（可用）        赠送包 21（55.33）到期 10-15
 *
 * Cycle half — 滚动 → 月度 → 每周, fixed order, each item ALWAYS two lines
 * (name + numbers, then its own full-width bar):
 *
 *   [✦] 每周                       100 / 100 · 于 10-06 重置
 *   [==================== 100%]
 *
 * Stored-value rows (余额/代金券) are two-line too, but the right-hand side is a
 * single value with the unit as small print — they are settled balances that
 * always read X/X, so "X / Y" carried no information:
 *
 *   [✦] 余额                            14.95（CNY）
 *   [==================== 100%]
 *
 * SEMANTICS:
 *  - Aggregate summaries ("Total Points") are derived data — excluded from
 *    the chart; the expanded details show the ORIGINAL rows untouched.
 *  - Additive pool (签到积分型): only family packs, the monthly window (when a
 *    family coexists — its reset day acts as its expiry), and stored-value
 *    singletons sum into 余额. Rolling/weekly are limits, never additive, so
 *    they stay out of the pool total.
 *  - Stored-value singletons (余额/代金券) do not sum into 余额 as separate
 *    pools — identical-value ones are collapsed first (stepfun-cn).
 */

const MAX_SEGMENTS = 20;

/** CreditDaddy's `credit` icon — twin four-point sparkles (feather-style). */
function CreditIcon({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function remainingOf(p) {
  if (p.remaining !== undefined && p.remaining !== null) return Math.max(0, Number(p.remaining));
  return Math.max(0, Number(p.total || 0) - Number(p.used || 0));
}



/**
 * One quota item — ALWAYS two lines, so every row on every card scans the same:
 *
 *   [✦] 每周                        5.96 / 6 · 于 10-06 重置
 *   [==================== 99.3%]
 *
 * `depth` indents nested cycle layers (see buildNestedCycle) and `widthPct`
 * carries the shared-measure width; at depth 0 it is a plain full-width row.
 *
 * Stored-value rows (`balance` 类) read the other way round — the AMOUNT is the
 * headline (large) with its unit as small print, and the label becomes the
 * small right-aligned caption. They have no denominator, so the bar encodes
 * only "has balance" (full, green) vs "empty" (empty, red):
 *
 *   14.95（CNY）                            余额
 *   [==================== 100%]
 */
function QuotaRow({ row, depth = 0, widthPct = null }) {
  const total = Number((row.totalNum ?? row.total) || 0);
  const remaining = Number.isFinite(row.remainingNum)
    ? Number(row.remainingNum)
    : Number(row.remaining ?? remainingOf(row));
  const stored = isStoredValueRow(row);
  const recurring = row.recurring === true || isRecurringQuotaRow(row);
  const word = recurring ? translate("resets") : translate("expires");

  if (stored) {
    const unit = quotaUnitOf(row.name);
    const hasBalance = remaining > 0;
    return (
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-baseline justify-between gap-2 tabular-nums">
          <span className="flex min-w-0 items-baseline gap-1">
            <CreditIcon className="size-[11px] shrink-0 self-center text-text-muted" />
            <b className="text-[12px] font-bold text-text">{fmt(remaining)}</b>
            {unit ? <span className="text-[10px] text-text-muted">（{unit}）</span> : null}
          </span>
          <span className="shrink-0 text-[11px] text-text-muted">
            {translateQuotaName(nameWithoutUnit(row.name) || row.name)}
          </span>
        </div>
        <div className="h-[5px] w-full overflow-hidden rounded-[3px] bg-black/10 dark:bg-white/10">
          <div
            className={cn("h-full rounded-[3px]", hasBalance ? "bg-green-500/90" : "bg-red-500/90")}
            style={{ width: hasBalance ? "100%" : "0%" }}
          />
        </div>
      </div>
    );
  }

  // Cycle rows keep the FULL name for the dictionary lookup — the parenthetical
  // is part of the key ("session (5h)" → 滚动). Stripping it silently produced
  // the raw English name on the card.
  const pct = widthPct !== null ? widthPct : percentOf(row);
  return (
    <div className="min-w-0 space-y-1" style={depth > 0 ? { paddingLeft: `${depth * 14}px` } : undefined}>
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          {depth > 0 ? (
            <span className="shrink-0 text-text-muted/60">└</span>
          ) : (
            <CreditIcon className="size-[11px] shrink-0 text-text-muted" />
          )}
          <span className="truncate text-text-muted">{translateQuotaName(row.name)}</span>
        </span>
        <span className="shrink-0 text-text-muted">
          {translate("remaining {remaining} of {total}")
            .replace("{remaining}", fmt(remaining))
            .replace("{total}", fmt(total))}
          {row.resetAt
            ? `　${word.replace("{date}", shortDate(row.resetAt))}`
            : ""}
        </span>
      </div>
      <div className="h-[5px] w-full overflow-hidden rounded-[3px] bg-black/10 dark:bg-white/10">
        <div
          className={cn("h-full rounded-[3px]", recurring ? "bg-sky-500/80" : "bg-green-500/90")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The nested cycle allowance as ONE bar.
 *
 * 滚动 ⊂ 每周 ⊂ 月度额度 are three scopes of the same allowance, so they share a
 * single track rather than stacking three bars: the outermost layer is the full
 * track, and each inner layer is a span nested inside its parent's span.
 *
 *   [██████████████████████████]  ← 月度额度 9.96/10 (outermost, full track)
 *   [██████████████            ]  ← 每周 5.96/6   (inset, 99.4% of the month)
 *   [██████████████            ]  ← 滚动 3/3      (inset again, fills那个每周 span)
 *
 * Rendered with absolutely-positioned bands inside one track, each a bit
 * shorter and lighter than its parent so all three are visible at once.
 */
function NestedCycleTrack({ ladder }) {
  // ladder is outermost-first; its last entry is the innermost span.
  const bands = ladder.map(({ row, widthPct }, i) => ({
    row,
    widthPct,
    // Innermost looks strongest; each outer ring is progressively softer.
    opacity: 0.25 + (0.55 * (i + 1)) / ladder.length,
  }));

  const outer = ladder[0]?.row;
  const inner = ladder[ladder.length - 1]?.row;

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          <CreditIcon className="size-[11px] shrink-0 text-text-muted" />
          <span className="truncate text-text-muted">
            {translateQuotaName(outer?.name || "")}
          </span>
        </span>
        <span className="shrink-0 text-text-muted">
          {translate("remaining {remaining} of {total}")
            .replace("{remaining}", fmt(ladder[0].ownRemaining))
            .replace("{total}", fmt(ladder[0].ownTotal))}
          {outer?.resetAt
            ? `　${translate("resets").replace("{date}", shortDate(outer.resetAt))}`
            : ""}
        </span>
      </div>

      <div
        className="relative h-[7px] w-full overflow-hidden rounded-[3px] bg-black/10 dark:bg-white/10"
        role="img"
        aria-label={ladder
          .map(({ row, ownRemaining, ownTotal }) =>
            `${translateQuotaName(row.name)} ${fmt(ownRemaining)}/${fmt(ownTotal)}`)
          .join("，")}
      >
        {bands.map(({ row, widthPct, opacity }, i) => (
          <span
            key={`${row.name || "band"}-${i}`}
            className="absolute inset-y-0 left-0 rounded-[3px] bg-sky-500"
            style={{ width: `${widthPct}%`, opacity }}
            title={`${translateQuotaName(row.name)} ${fmt(ladder[i].ownRemaining)}/${fmt(ladder[i].ownTotal)}`}
          />
        ))}
      </div>

      {/* Each layer's own numbers, so the nesting is readable without hovering.
          The innermost line is what actually binds you right now. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-text-muted">
        {ladder.map(({ row, ownRemaining, ownTotal }, i) => (
          <span key={`${row.name || "lbl"}-${i}`} className="inline-flex min-w-0 items-center gap-1">
            {i > 0 ? <span className="shrink-0 opacity-50">└</span> : null}
            <span className="truncate">{translateQuotaName(row.name)}</span>
            <span className="shrink-0">
              {fmt(ownRemaining)} / {fmt(ownTotal)}
            </span>
          </span>
        ))}
        {inner?.resetAt ? (
          <span className="shrink-0">
            {translate("resets").replace("{date}", shortDate(inner.resetAt))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

NestedCycleTrack.propTypes = {
  ladder: PropTypes.arrayOf(PropTypes.object).isRequired,
};

QuotaRow.propTypes = {
  row: PropTypes.shape({
    name: PropTypes.string,
    used: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    total: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    remaining: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    remainingNum: PropTypes.number,
    totalNum: PropTypes.number,
    resetAt: PropTypes.oneOfType([PropTypes.string, PropTypes.instanceOf(Date)]),
    recurring: PropTypes.bool,
  }),
};

export default function QuotaPackBar({ packs = [], className }) {
  const rows = (packs || []).filter((p) => p && typeof p === "object" && !isAggregateQuotaRow(p));
  if (rows.length === 0) return null;

  const withNums = rows.map((p) => {
    const totalNum = Number(p.total || 0);
    return { ...p, totalNum, remainingNum: remainingOf(p) };
  });

  // Cycle rows split two ways (see classifyCycleRows): MONTHLY rows are resource
  // packs that expire at month end (codebuddy / qoder), so they belong in the
  // additive pool; everything else recurring forms the nested 滚动⊂每周 ladder.
  const cycle = classifyCycleRows(withNums);
  const ladder = buildNestedCycle(withNums);
  // Rows that get their own line under the pool bar. Monthly is in here TOO —
  // it counts into the pool and the total, and still shows its own window row.
  const cycleLines = cycleRowLines(withNums);
  const monthlyPacks = cycle.monthly;

  // Non-recurring rows: same-base-name groups with ≥2 members are a pack
  // family; singletons are stored-value pools (余额/代金券) → their own rows.
  // Qoder-style 合集行「资源包」已在上游包含全部赠送包：存在时排除赠送包
  // 家族行，防止资源包 Credits 与赠送包被重复计数（用户实测重复）。
  const hasCollectionRow = withNums.some((p) => String(p.name || "") === "资源包");
  const nonRecurring = withNums
    .filter((p) => !isRecurringQuotaRow(p))
    .filter((p) => !(hasCollectionRow && String(p.name || "").startsWith("赠送包")));
  const groups = new Map();
  for (const p of nonRecurring) {
    const base = String(p.name || "").replace(/\s*\d+\s*$/, "").trim();
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(p);
  }
  const families = [...groups.entries()]
    .map(([base, members]) => {
      const totalNum = members.reduce((s, p) => s + p.totalNum, 0);
      const usedNum = members.reduce((s, p) => s + Number(p.used || 0), 0);
      const remainingNum = members.reduce((s, p) => s + p.remainingNum, 0);
      return { base, members, totalNum, usedNum, remainingNum, live: members.filter((p) => p.remainingNum > 0 && p.totalNum > 0) };
    })
    .filter((f) => f.members.length >= 2 && f.totalNum > 0);
  const familyMemberSet = new Set(families.flatMap((f) => f.members));
  // Stored-value singletons with IDENTICAL values are the same pool rendered
  // twice upstream (stepfun-cn: 余额(CNY) + 代金券(CNY) both 14.95/14.95) —
  // 去重，不累加（用户实测「其实是一个」）。
  const seenSig = new Set();
  const singletonPools = nonRecurring.filter((p) => {
    if (familyMemberSet.has(p)) return false;
    const sig = `${Number(p.used || 0)}|${Number(p.total || 0)}|${p.resetAt || ""}`;
    if (seenSig.has(sig)) return false;
    seenSig.add(sig);
    return true;
  });

  // Additive pool (签到积分型 + Qoder 系列积分): family packs + monthly resource
  // packs (月底到期的包 — 与 qoder 同理，计入总量) + stored-value singletons
  // (余额/代金券/套餐内 Credits——用户拍板：Qoder 也用同一逻辑，都是积分).
  // The 滚动/每周 ladder is a limit, not additive — it never joins the pool.
  const pool = [
    ...families.flatMap((f) => f.members),
    ...monthlyPacks,
    ...singletonPools,
  ];
  const poolTotal = pool.reduce((s, p) => s + p.totalNum, 0);
  const poolRemaining = pool.reduce((s, p) => s + p.remainingNum, 0);
  // A one-row pool is already fully described by the big aggregate line and the
  // When the pool collapses to ONE logical thing, its individual row must not be
  // re-listed underneath — the aggregate line above already is that row (Qoder:
  // 资源包; stepfun: 余额). The BAR still renders: it is the visual meter for that
  // same value, and dropping it removed the only progress indication on the card.
  //
  // Counts COLLAPSED families too: Qoder's `资源包` is a 2-member family shown as
  // a single aggregate row, so it counts as one.
  const poolRowCount = families.length + singletonPools.length + monthlyPacks.length;
  const isPoolFullyRepresented = poolRowCount <= 1;
  // A "settled balance" is a single stored-value pool: nothing decrements its
  // total, so `remaining / total` is always the full amount and printing it is
  // noise. True for stepfun's 余额/代金券; false for Qoder's 资源包 (a real
  // 100 / 900) and for any summing family.
  const poolIsSettledBalance =
    poolRowCount === 1 && pool.length > 0 && pool.every((p) => isStoredValueRow(p));
  // Currency/credit unit for the settled balance headline ("14.95（CNY）").
  // Taken from the pool row's name — the settled-balance path renders the
  // aggregate line rather than a QuotaRow, so it has to re-derive the unit
  // QuotaRow would otherwise read for itself.
  const poolUnit = poolIsSettledBalance ? quotaUnitOf(pool[0]?.name) : "";

  // 原生包名展示修正：合集池「资源包」→「资源包 Credits」。
  const displayPackName = (name) => (name === "资源包" ? "资源包 Credits" : name);

  const hasFamily = families.length > 0;

  const renderPoolBar = (poolPacks, poolTotal) => {
    const livePacks = poolPacks
      .filter((p) => p.remainingNum > 0 && p.totalNum > 0)
      .sort((a, b) => String(a.resetAt || "").localeCompare(String(b.resetAt || "")));
    let oneShotIdx = 0;
    const withAlpha = livePacks.map((p) => ({
      ...p,
      alpha: p.recurring === true ? 1 : Math.max(0.45, 0.85 - oneShotIdx++ * 0.05),
    }));
    let segments = withAlpha;
    if (withAlpha.length > MAX_SEGMENTS) {
      const kept = withAlpha.slice(0, MAX_SEGMENTS - 1);
      const rest = withAlpha.slice(MAX_SEGMENTS - 1);
      segments = [
        ...kept,
        {
          name: translate("{count} more packs").replace("{count}", String(rest.length)),
          remainingNum: rest.reduce((s, p) => s + p.remainingNum, 0),
          totalNum: rest.reduce((s, p) => s + p.totalNum, 0),
          resetAt: rest[0]?.resetAt || null,
          recurring: false,
          alpha: 0.6,
        },
      ];
    }
    const poolUsed = poolPacks.reduce((s, p) => s + Number(p.used || 0), 0);
    const usedShare = poolTotal > 0 ? poolUsed / poolTotal : 0;
    return (
      <div
        className="flex w-full gap-[2px] overflow-hidden rounded-[3px] bg-black/10 dark:bg-white/10"
        style={{ height: "5px" }}
        role="img"
        aria-label={translate("{count} packs, remaining {remaining} of {total}")
          .replace("{count}", String(livePacks.length))
          .replace("{remaining}", fmt(poolPacks.reduce((s, p) => s + p.remainingNum, 0)))
          .replace("{total}", fmt(poolTotal))}
      >
        {segments.map((p, i) => {
          const share = poolTotal > 0 ? p.remainingNum / poolTotal : 0;
          const expiresWord = p.recurring === true ? translate("resets") : translate("expires");
          return (
            <span
              key={`${p.name || "pack"}-${i}`}
              className={cn("block h-full min-w-[3px]", p.recurring === true ? "bg-sky-500" : "bg-green-500")}
              style={{ flex: `${share.toFixed(4)} 1 0`, opacity: p.alpha }}
              title={[
                p.name || translate("Quota package"),
                `${translate("Remaining")} ${fmt(p.remainingNum)} / ${fmt(p.totalNum)}`,
                p.resetAt ? `${expiresWord} ${shortDate(p.resetAt)}` : null,
              ].filter(Boolean).join("，")}
            />
          );
        })}
        {poolUsed > 0 && (
          <span
            className="block h-full min-w-[3px] bg-black/20 dark:bg-white/20"
            style={{ flex: `${usedShare.toFixed(4)} 1 0` }}
            title={`${translate("Used")} ${fmt(poolUsed)}`}
          />
        )}
      </div>
    );
  };

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      {/* Line 1: 大号余额（无「剩余」二字）←→ X / 共 T。
          用户拍板：数字保持 16px 大字，唯一要求是**底部对齐** ——
          小字（单位/分母）的盒底与大字的盒底齐平，不再是垂直居中的浮标。
          做法：整行 items-end，给大字加 leading-none 让它的盒子贴合字形
          （否则 `b` 的 line-box 高出字形，任何基线/底边对齐都会差半个行高）。 */}
      {pool.length > 0 && (
        <div className="flex items-end justify-between gap-3">
          <span className="flex items-end gap-1.5 tabular-nums">
            <CreditIcon className="size-[13px] shrink-0 self-center text-primary" />
            <b className="text-[16px] font-bold leading-none text-text">{fmt(poolRemaining)}</b>
            {poolUnit ? (
              <span className="text-[10px] leading-none text-text-muted">（{poolUnit}）</span>
            ) : null}
          </span>
          {/* A settled balance has no denominator worth printing — `14.95 / 14.95`
              just reprinted the big number beside it. Everything else keeps it:
              a summing family (CodeBuddy's packs) and a single pool with a real
              denominator (Qoder 100 / 900, the number the bar below measures). */}
          {!poolIsSettledBalance && (
            <span className="inline-flex shrink-0 items-baseline text-xs leading-none tabular-nums text-text-muted">
              {fmt(poolRemaining)} / {fmt(poolTotal)}
            </span>
          )}
        </div>
      )}
      {/* Additive pool bar: family packs + monthly (月度并入聚合，不单独成行).
          Hidden when the pool is one settled balance — a "progress" bar over a
          value with no denominator says nothing, and it was the second of the
          two bars stepfun showed. */}
      {pool.length > 0 && renderPoolBar(pool, poolTotal)}

      {/* Qoder 系合集说明：资源包 Credits 已包含套餐内 Credits 等（用户要求同步标注） */}
      {hasCollectionRow && (
        <div className="text-[11px] text-text-muted">
          {translate("includes {names}").replace(
            "{names}",
            [...singletonPools.map((p) => translateQuotaName(displayPackName(p.name))), "资源包 Credits"].join("、")
          )}
        </div>
      )}

      {/* 资源包计数行：可用数（可用）+ 最近一个包（实际名称）的剩余与绝对到期。
          无到期信息的卡（Qoder 系）省略此行。 */}
      {pool.length > 0 && (() => {
        const liveCount = pool.filter((p) => p.remainingNum > 0).length;
        const soonestLive = pool
          .filter((p) => p.resetAt && p.remainingNum > 0)
          .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;
        if (!soonestLive) return null;
        return (
          <div className="flex items-center justify-between gap-3 text-[11px] tabular-nums">
            <span className="text-text-muted">
              {translate("{count} resource packs").replace("{count}", String(liveCount))}
            </span>
            <span className="inline-flex min-w-0 items-center gap-3 truncate text-text-muted">
              {/* No pack name: the credit icon + amount + expiry already say
                  which pack this is, and "赠送包 21" alongside the pool bar just
                  repeated the row above. */}
              <span className="inline-flex shrink-0 items-center gap-1">
                <CreditIcon className="size-[11px] shrink-0" />
                {fmt(soonestLive.remainingNum)}
              </span>
              <span className="shrink-0">
                {translate(
                  soonestLive.recurring === true || isRecurringQuotaRow(soonestLive)
                    ? "resets"
                    : "expires {date}"
                ).replace("{date}", shortDate(soonestLive.resetAt))}
              </span>
            </span>
          </div>
        );
      })()}

      {/* 储值类（余额/代金券/现金）：同样是「一项两行」，但右侧是单值 + 小字
          单位 —— 它们恒为 X/X，显示 "/ 总量" 没有信息量。 */}
      {/* Stored-value singletons (余额/代金券) get their own row. But when the
          pool is exactly ONE row (Qoder: just 资源包), that row IS what the big
          aggregate line + segmented bar above already show — rendering it again
          here printed the same "100 / 100" a second time and read as two
          separate quotas. Only render the individual rows when the pool holds
          more than one distinct thing (e.g. stepfun-cn's 余额 + 代金券). */}
      {singletonPools.length > 0 && !isPoolFullyRepresented && (
        <>
          {singletonPools.map((p, i) => (
            <QuotaRow key={`${p.name || "pool"}-${i}`} row={p} />
          ))}
        </>
      )}

      {/* Cycle rows. Two distinct shapes, decided by the DATA (see
          buildNestedCycle):

          - Contained chain (commandcode: 月度额度 ⊃ 每周 ⊃ 滚动) → a ladder,
            each layer indented under its parent and inset to its share, so it
            reads as "this much of the parent's allowance".
          - Independent windows (antigravity: a family's `5h Window` and
            `Weekly Window`, or mimo's lone Weekly) → no ladder; each renders as
            its own plain full-width bar. They measure different things and
            must not be stacked.

          `cycleLines` (not `cycle.windows`) is the flat list, because a MONTHLY
          row belongs in both places: it is summed into the pool bar above AND
          gets its own progress row here. */}
      {ladder.length > 0 ? (
        // A real containment chain → ONE track with nested spans, not one bar
        // per layer. 滚动 ⊂ 每周 ⊂ 月度额度 share a single measure.
        <NestedCycleTrack ladder={ladder} />
      ) : (
        cycleLines.map((row, i) => <QuotaRow key={`${row.name || "win"}-${i}`} row={row} />)
      )}
    </div>
  );
}

QuotaPackBar.propTypes = {
  packs: PropTypes.arrayOf(
    PropTypes.shape({
      name: PropTypes.string,
      used: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
      total: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
      remaining: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
      resetAt: PropTypes.oneOfType([PropTypes.string, PropTypes.instanceOf(Date)]),
      recurring: PropTypes.bool,
    })
  ),
  className: PropTypes.string,
};
