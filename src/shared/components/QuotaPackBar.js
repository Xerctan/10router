"use client";

import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

/**
 * Connection quota block — CreditDaddy account-card language.
 *
 *   剩余 [✦✦] 2,455.33      100 于 10-15 到期 · 已用 U / 共 T      ← only when a pack family exists
 *   [赠送包 family: proportional segments | trailing used chunk]
 *   滚动   ▓▓▓░  剩 2.91 / 3 · 09-30 重置                     ← meter row, always visible
 *   每周   ▓▓▓░  剩 5.91 / 6 · 09-30 重置
 *   余额   ▓▓▓░  剩 14.95 / 14.95 · 10-20 到期
 *
 * SEMANTICS:
 *  - Aggregate summaries ("Total Points") are derived data — excluded.
 *  - Same-family packs (base name minus trailing index, ≥2 members) aggregate
 *    into one segmented bar + the 剩余 total.
 *  - Subscription-recurring windows (Monthly/每周/滚动…) and stored-value
 *    singletons (余额/代金券) are DIFFERENT-relationship pools: never summed,
 *    each renders as its own always-visible meter row (they replace the old
 *    table rows for these kinds).
 */

const MAX_SEGMENTS = 20;
const AGGREGATE_RE = /total|aggregate|summary|^总/i;
const RECURRING_NAME_RE = /month|月|week|周|滚动|rolling/i;

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

/** Aggregate/summary rows are derived data — never charted, never summed. */
export function isAggregateQuotaRow(row) {
  return AGGREGATE_RE.test(String(row?.name || ""));
}

/** Subscription-recurring window: explicit flag or a cycle-named row. */
export function isRecurringQuotaRow(row) {
  if (row?.recurring === true) return true;
  return RECURRING_NAME_RE.test(String(row?.name || ""));
}

/** One always-visible meter row (name | bar | 剩 X / Y · word date). */
function MeterRow({ row }) {
  const total = Number(row.totalNum || row.total || 0);
  const remaining = Number(row.remainingNum ?? remainingOf(row));
  const pct = total > 0 ? Math.min(100, (remaining / total) * 100) : 0;
  const recurring = row.recurring === true || isRecurringQuotaRow(row);
  const word = recurring ? translate("resets") : translate("expires");
  return (
    <div className="flex min-w-0 items-center gap-2 text-[11px] tabular-nums">
      <span className="w-16 shrink-0 truncate text-text-muted">{row.name}</span>
      <div className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-[3px] bg-black/10 dark:bg-white/10">
        <div
          className={cn("h-full rounded-[3px]", recurring ? "bg-sky-500/80" : "bg-green-500/90")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 text-text-muted">
        {translate("remaining {remaining} of {total}")
          .replace("{remaining}", fmt(remaining))
          .replace("{total}", fmt(total))}
        {row.resetAt ? ` · ${word} ${shortDate(row.resetAt)}` : ""}
      </span>
    </div>
  );
}

MeterRow.propTypes = {
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

  // Recurring windows: always-visible meter rows — never summed into 剩余
  // (their constraints are parallel, not additive).
  const recurringRows = withNums.filter((p) => isRecurringQuotaRow(p));

  // Non-recurring rows: same-base-name groups with ≥2 members are a pack
  // family (aggregatable); singletons are stored-value pools (余额/代金券) —
  // rendered as meter rows, never summed into 剩余 (用户拍板：储值类不聚合).
  const nonRecurring = withNums.filter((p) => !isRecurringQuotaRow(p));
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
      const soonPack = members
        .filter((p) => p.resetAt && p.remainingNum > 0)
        .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;
      return { base, members, totalNum, usedNum, remainingNum, soonPack, live: members.filter((p) => p.remainingNum > 0 && p.totalNum > 0) };
    })
    .filter((f) => f.members.length >= 2 && f.totalNum > 0);
  const familyMemberSet = new Set(families.flatMap((f) => f.members));
  const singletonPools = nonRecurring.filter((p) => !familyMemberSet.has(p));

  const hasFamily = families.length > 0;

  // Family bars: one per family (proportional segments + trailing used chunk).
  const renderFamilyBar = (family) => {
    const livePacks = family.live
      .sort((a, b) => {
        const ta = a.resetAt ? new Date(a.resetAt).getTime() : Infinity;
        const tb = b.resetAt ? new Date(b.resetAt).getTime() : Infinity;
        return ta - tb;
      });
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
          name: family.base,
          remainingNum: rest.reduce((s, p) => s + p.remainingNum, 0),
          totalNum: rest.reduce((s, p) => s + p.totalNum, 0),
          resetAt: rest[0]?.resetAt || null,
          recurring: false,
          alpha: 0.6,
        },
      ];
    }
    const usedShare = family.totalNum > 0 ? family.usedNum / family.totalNum : 0;
    return (
      <div
        className="flex w-full gap-[2px] overflow-hidden rounded-[3px] bg-black/10 dark:bg-white/10"
        style={{ height: "5px" }}
        role="img"
        aria-label={translate("{name}: {count} packs, remaining {remaining} of {total}")
          .replace("{name}", family.base)
          .replace("{count}", String(family.live.length))
          .replace("{remaining}", fmt(family.remainingNum))
          .replace("{total}", fmt(family.totalNum))}
      >
        {segments.map((p, i) => {
          const share = family.totalNum > 0 ? p.remainingNum / family.totalNum : 0;
          const expiresWord = p.recurring === true ? translate("resets") : translate("expires");
          return (
            <span
              key={`${p.name || "pack"}-${i}`}
              className={cn("block h-full min-w-[3px]", p.recurring === true ? "bg-sky-500" : "bg-green-500")}
              style={{ flex: `${share.toFixed(4)} 1 0`, opacity: p.alpha }}
              title={[
                p.name || family.base,
                `${translate("Remaining")} ${fmt(p.remainingNum)} / ${fmt(p.totalNum)}`,
                p.resetAt ? `${expiresWord} ${shortDate(p.resetAt)}` : null,
              ].filter(Boolean).join("，")}
            />
          );
        })}
        {family.usedNum > 0 && (
          <span
            className="block h-full min-w-[3px] bg-black/20 dark:bg-white/20"
            style={{ flex: `${usedShare.toFixed(4)} 1 0` }}
            title={`${translate("Used")} ${fmt(family.usedNum)}`}
          />
        )}
      </div>
    );
  };

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      {/* 剩余 total: aggregatable family pools only (储值类 singletons excluded,
          用户拍板) — and only when a family exists to aggregate. */}
      {hasFamily && (
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <span className="text-xs text-text-muted">{translate("Remaining")}</span>
            <CreditIcon className="size-[13px] text-primary" />
            {/* 大号（约 +20%）：CreditDaddy 的主数字位，显眼优先 */}
            <b className="text-base font-bold text-text">{fmt(families.reduce((s, f) => s + f.remainingNum, 0))}</b>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs tabular-nums text-text-muted">
            {(() => {
              const soon = families
                .map((f) => f.soonPack)
                .filter(Boolean)
                .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;
              const totalAll = families.reduce((s, f) => s + f.totalNum, 0);
              const totalUsed = families.reduce((s, f) => s + f.usedNum, 0);
              if (!soon) return `${translate("Used")} ${fmt(totalUsed)} / ${fmt(totalAll)}`;
              return translate("expires {date} · used {used} of {total}")
                .replace("{date}", shortDate(soon.resetAt))
                .replace("{used}", fmt(totalUsed))
                .replace("{total}", fmt(totalAll));
            })()}
          </span>
        </div>
      )}
      {hasFamily && families.map((family) => <div key={family.base} className="min-w-0">{renderFamilyBar(family)}</div>)}

      {/* Recurring windows + stored-value singletons: always-visible meter
          rows in the same visual language (they replace the old table rows
          for these kinds). Original order preserved. */}
      {withNums
        .filter((p) => isRecurringQuotaRow(p) || singletonPools.includes(p))
        .map((p, i) => <MeterRow key={`${p.name || "row"}-${i}`} row={p} />)}
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
