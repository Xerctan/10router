"use client";

import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

/**
 * Connection quota block — CreditDaddy account-card language (签到积分型).
 *
 *   余额 [✦✦] 2,455.33      Bonus Pack 24 于 2 天 23 小时 过期
 *   [family: proportional segments | trailing used chunk]   ← 月度并入：
 *     它就是「以重置日为到期日的资源包」，不再单独成行
 *
 * SEMANTICS:
 *  - Aggregate summaries ("Total Points") are derived data — excluded from
 *    the chart; the expanded details show the ORIGINAL rows untouched.
 *  - Additive pool (签到积分型): when a pack family (≥2 same-base-name
 *    non-recurring rows) coexists with a monthly window, the monthly joins
 *    the bar + the 余额 total — its reset day acts as its expiry ("最后一天
 *    的资源包"), and it no longer renders as its own row.
 *  - Parallel-constraint recurring windows without such a family (commandcode
 *    滚动/每周/月度额度) stay as per-window meter rows — they are limits, not
 *    an additive pool (用户此前的拍板保持).
 *  - Stored-value singletons (余额/代金券) render as meter rows too, but do
 *    not sum into 余额 (不同花费池).
 */

const MAX_SEGMENTS = 20;
const AGGREGATE_RE = /total|aggregate|summary|^总/i;
const MONTHLY_RE = /month|月/i;
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
  const total = Number((row.totalNum ?? row.total) || 0);
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

  // Monthly window (签到积分型): additive resource pack whose "expiry" is its
  // reset day — joins the bar + the 余额 total when a pack family coexists.
  const monthly = withNums.find(
    (p) => isRecurringQuotaRow(p) && MONTHLY_RE.test(String(p.name || ""))
  ) || null;

  // Non-recurring rows: same-base-name groups with ≥2 members are a pack
  // family; singletons are stored-value pools (余额/代金券) → meter rows.
  const nonRecurring = withNums.filter((p) => p !== monthly && !isRecurringQuotaRow(p));
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
  const singletonPools = nonRecurring.filter((p) => !familyMemberSet.has(p));

  // Other recurring windows (每周/滚动…) without a family to join: meter rows.
  const parallelWindows = withNums.filter(
    (p) => isRecurringQuotaRow(p) && p !== monthly
  );

  // Additive pool (签到积分型 + Qoder 系列积分): family packs + the monthly
  // window (当家族存在时并入) + stored-value singletons (余额/代金券/套餐内
  // Credits——用户拍板：Qoder 也用同一逻辑，都是积分). Parallel recurring
  // windows without a family stay as meter rows (limits, not additive).
  const pool = [
    ...families.flatMap((f) => f.members),
    ...(monthly && families.length > 0 ? [monthly] : []),
    ...singletonPools,
  ];
  const poolTotal = pool.reduce((s, p) => s + p.totalNum, 0);
  const poolRemaining = pool.reduce((s, p) => s + p.remainingNum, 0);

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
      {/* Line 1: icon + 大号余额（无「剩余」二字）←→ 剩 X / 共 T */}
      {pool.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <CreditIcon className="size-[13px] text-primary" />
            <b className="text-xl font-bold text-text">{fmt(poolRemaining)}</b>
          </span>
          <span className="inline-flex items-center gap-1 text-xs tabular-nums text-text-muted">
            {translate("remaining {remaining} of {total}")
              .replace("{remaining}", fmt(poolRemaining))
              .replace("{total}", fmt(poolTotal))}
          </span>
        </div>
      )}
      {/* Additive pool bar: family packs + monthly (月度并入聚合，不单独成行) */}
      {pool.length > 0 && renderPoolBar(pool, poolTotal)}

      {/* 资源包计数行：可用数 + 最近一个包（实际名称）的剩余与绝对到期。
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
            <span className="inline-flex min-w-0 items-center gap-2 truncate text-text-muted">
              <span className="truncate">
                {displayPackName(soonestLive.name)}
              </span>
              <span>
                {translate("remaining {remaining} of {total}")
                  .replace("{remaining}", fmt(soonestLive.remainingNum))
                  .replace("{total}", fmt(soonestLive.totalNum))}
                {" "}
                {translate("expires on {date}").replace("{date}", shortDate(soonestLive.resetAt))}
              </span>
            </span>
          </div>
        );
      })()}

      {/* Parallel-constraint recurring windows without a family (每周/滚动…):
          own meter rows — limits, not an additive pool. */}
      {parallelWindows.map((p, i) => (
        <MeterRow key={`${p.name || "win"}-${i}`} row={{ ...p, totalNum: p.totalNum, remainingNum: p.remainingNum }} />
      ))}
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
