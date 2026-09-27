"use client";

import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

/**
 * Connection quota summary block — CreditDaddy account-card language:
 *
 *   剩余 [✦✦ credit icon] 2,455.33    100 于 10-16 到期 · 已用 U / 共 T
 *   [赠送包 family: proportional segments | trailing used chunk]
 *   滚动   ▓▓▓░  剩 2.91 / 3 · 09-30 重置      ← recurring window bar
 *   每周   ▓▓▓░  剩 5.91 / 6 · 09-30 重置      ← one bar per window
 *   月度   ▓▓▓░  剩 9.9 / 10 · 10-01 重置
 *
 * SEMANTICS (CreditDaddy-faithful): only same-family packs aggregate into a
 * segmented bar ("Bonus Pack 24/25…" — base name minus trailing index, ≥2
 * members). Subscription-recurring windows (Monthly/Weekly/滚动…) are NOT
 * part of the pack pool and never sum into 剩余 — each gets its own
 * progress-bar row in the same visual language. Aggregate summary rows
 * ("Total Points") are derived data and excluded everywhere. Other
 * different-relationship singletons (余额 vs 代金券) stay in the details
 * table — never charted into one number.
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

/** Subscription-recurring window: explicit flag or a cycle-named row. */
function isRecurringWindow(p) {
  if (p.recurring === true) return true;
  return RECURRING_NAME_RE.test(String(p.name || ""));
}

/** Aggregate/summary rows are derived data — never charted, never summed. */
export function isAggregateQuotaRow(row) {
  return AGGREGATE_RE.test(String(row?.name || ""));
}

export default function QuotaPackBar({ packs = [], className }) {
  const rows = (packs || []).filter((p) => p && typeof p === "object" && !isAggregateQuotaRow(p));
  if (rows.length === 0) return null;

  const withNums = rows.map((p) => {
    const totalNum = Number(p.total || 0);
    return { ...p, totalNum, remainingNum: remainingOf(p) };
  });

  // Recurring windows: excluded from 剩余 and from family bars (their rows
  // stay readable in the collapsed details table) — parallel constraints, not
  // an additive pool. 用户拍板：样式也隐藏。
  const packRows = withNums.filter((p) => !isRecurringWindow(p));

  // Family packs: base-name groups with ≥2 members. 储值类 singletons
  // (余额/代金券/…) are NOT aggregated — different spending scopes, and a
  // card without any family pool renders no top block at all.
  const groups = new Map();
  for (const p of packRows) {
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
        .filter((p) => p.recurring !== true && p.resetAt && p.remainingNum > 0)
        .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;
      return { base, members, totalNum, usedNum, remainingNum, soonPack, live: members.filter((p) => p.remainingNum > 0 && p.totalNum > 0) };
    })
    .filter((f) => f.members.length >= 2 && f.totalNum > 0);

  if (families.length === 0) return null;

  // 剩余 = the aggregatable family pools only (储值类 singletons excluded).
  const totalRemaining = families.reduce((s, f) => s + f.remainingNum, 0);
  const totalAll = families.reduce((s, f) => s + f.totalNum, 0);
  const totalUsed = families.reduce((s, f) => s + f.usedNum, 0);

  // Earliest live expiry across the family pools drives the right-hand meta.
  const soon = families
    .map((f) => f.soonPack)
    .filter(Boolean)
    .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      {/* Line 1: account remaining (left) + earliest pack expiry / used / total */}
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <span className="text-text-muted">{translate("Remaining")}</span>
          <CreditIcon className="size-[13px] text-primary" />
          <b className="font-bold text-text">{fmt(totalRemaining)}</b>
        </span>
        <span className="inline-flex min-w-0 items-center gap-1 truncate tabular-nums text-text-muted">
          {soon && (
            <>
              {fmt(soon.remainingNum)} {translate("expires {date} · used {used} of {total}")
                .replace("{date}", shortDate(soon.resetAt))
                .replace("{used}", fmt(totalUsed))
                .replace("{total}", fmt(totalAll))}
            </>
          )}
          {!soon && `${translate("Used")} ${fmt(totalUsed)} / ${fmt(totalAll)}`}
        </span>
      </div>

      {/* Family bars: one per same-name pack group (赠送包 / Bonus Pack…) */}
      {families.map((family) => {
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
          <div key={family.base} className="min-w-0">
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
          </div>
        );
      })}

      {/* Recurring windows (每月/每周/滚动…) are intentionally NOT rendered
          here (用户拍板：样式隐藏) — they stay readable in the collapsed
          per-pack details table when expanded. They are also excluded from
          剩余 and from family bars: subscription windows are parallel
          constraints, not an additive pool. */}
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
