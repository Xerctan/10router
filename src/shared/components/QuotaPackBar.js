"use client";

import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

/**
 * Connection quota summary block — CreditDaddy account-card language:
 *
 *   剩余 [paid] 2,455.33        100 于 10-16 到期 · 已用 U / 共 T
 *   [赠送包 family: proportional segments | trailing used chunk]
 *   月度 ▓▓░░ 剩 0 / 500 · 重置 10-16          ← pinned meter, when present
 *
 * SEMANTICS: only same-family packs aggregate into a bar ("Bonus Pack 24/25…"
 * — base name minus trailing index, ≥2 members). Aggregate summary rows
 * ("Total Points" — themselves derived) are excluded from every part; other
 * singletons (余额/代金券/滚动/每周) stay in the details table below — they
 * are different-relationship pools or independent reset windows and must
 * never be summed into one number.
 */

const MAX_SEGMENTS = 20;
const AGGREGATE_RE = /total|aggregate|summary|^总/i;
const MONTHLY_RE = /month|月/i;

/** Aggregate/summary rows are derived data — never charted, never summed. */
export function isAggregateQuotaRow(row) {
  return AGGREGATE_RE.test(String(row?.name || ""));
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

export default function QuotaPackBar({ packs = [], className }) {
  const rows = (packs || []).filter((p) => p && typeof p === "object" && !isAggregateQuotaRow(p));
  if (rows.length === 0) return null;

  const withNums = rows.map((p) => {
    const totalNum = Number(p.total || 0);
    return { ...p, totalNum, remainingNum: remainingOf(p) };
  });

  // Account-wide remaining: every non-aggregate row with a real pool. Rows
  // that only carry a percentage (antigravity-style windows) can't contribute
  // an absolute number and are skipped rather than guessed.
  const totalRemaining = withNums
    .filter((p) => p.totalNum > 0)
    .reduce((s, p) => s + p.remainingNum, 0);
  const totalAll = withNums.reduce((s, p) => s + p.totalNum, 0);
  const totalUsed = withNums.reduce((s, p) => s + Number(p.used || 0), 0);

  // Earliest live expiry across everything drives the right-hand meta.
  const soon = withNums
    .filter((p) => p.resetAt && p.remainingNum > 0 && p.totalNum > 0)
    .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;

  // Monthly window gets its own pinned meter (recurring refill semantics).
  const monthly = withNums.find((p) => MONTHLY_RE.test(String(p.name || ""))) || null;

  // Family packs: base-name groups with ≥2 members, excluding the monthly row.
  const familyRows = withNums.filter((p) => p !== monthly);
  const groups = new Map();
  for (const p of familyRows) {
    const base = String(p.name || "").replace(/\s*\d+\s*$/, "").trim();
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(p);
  }
  const families = [...groups.entries()]
    .map(([base, members]) => {
      const totalNum = members.reduce((s, p) => s + p.totalNum, 0);
      const remainingNum = members.reduce((s, p) => s + p.remainingNum, 0);
      const soonPack = members
        .filter((p) => p.recurring !== true && p.resetAt && p.remainingNum > 0)
        .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;
      return { base, members, totalNum, remainingNum, soonPack, live: members.filter((p) => p.remainingNum > 0 && p.totalNum > 0) };
    })
    .filter((f) => f.members.length >= 2 && f.totalNum > 0);

  return (
    <div className={cn("min-w-0", className)}>
      {/* Line 1: account remaining (left) + earliest expiry / used / total (right) */}
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1 tabular-nums">
          <span className="text-text-muted">{translate("Remaining")}</span>
          <span className="material-symbols-outlined text-[14px] text-green-600 dark:text-green-400">paid</span>
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

      {/* Monthly window pinned under the bar (recurring refill semantics). */}
      {monthly && (
        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] tabular-nums">
          <span className="shrink-0 truncate text-text-muted">{monthly.name}</span>
          <div className="h-[4px] min-w-0 flex-1 overflow-hidden rounded-[2px] bg-black/10 dark:bg-white/10">
            <div
              className="h-full bg-sky-500/80"
              style={{ width: `${monthly.totalNum > 0 ? Math.min(100, (monthly.remainingNum / monthly.totalNum) * 100) : 0}%` }}
            />
          </div>
          <span className="shrink-0 text-text-muted">
            {translate("remaining {remaining} of {total}")
              .replace("{remaining}", fmt(monthly.remainingNum))
              .replace("{total}", fmt(monthly.totalNum))}
            {monthly.resetAt ? ` · ${translate("resets")} ${shortDate(monthly.resetAt)}` : ""}
          </span>
        </div>
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
