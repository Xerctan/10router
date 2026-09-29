"use client";

import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { translateQuotaName } from "@/shared/utils/quotaName";
import {
  classifyCycleRows,
  isAggregateQuotaRow,
  isRecurringQuotaRow,
  isStoredValueRow,
  nameWithoutUnit,
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
 *   [icon] 每周                        100 / 100 · 于 10-06 重置
 *   [==================== 100%]
 *
 * The bar is its own full-width line (not wedged between the label and the
 * numbers), and is the same height/radius as the aggregate pool bar above.
 *
 * Stored-value rows (`balance` 类) swap the right-hand side for a single value
 * with the unit as small print — they are settled balances that always read
 * X/X, so `X / Y` would be pure noise:
 *
 *   余额                           14.95 (CNY)
 *   [==================== 100%]
 */
function QuotaRow({ row }) {
  const total = Number((row.totalNum ?? row.total) || 0);
  const remaining = Number(row.remainingNum ?? remainingOf(row));
  const pct = total > 0 ? Math.min(100, (remaining / total) * 100) : 0;
  const stored = isStoredValueRow(row);
  const recurring = row.recurring === true || isRecurringQuotaRow(row);
  const word = recurring ? translate("resets") : translate("expires");
  const unit = quotaUnitOf(row.name);
  // The unit lives next to the number, so the label drops it ("余额", not
  // "余额 (CNY)"). translateQuotaName is a no-op on already-localized names,
  // which is why the synthetic 0% Monthly placeholder can pass one through.
  const displayName = translateQuotaName(nameWithoutUnit(row.name) || row.name);

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          <CreditIcon className="size-[11px] shrink-0 text-text-muted" />
          <span className="truncate text-text-muted">{displayName}</span>
        </span>
        <span className="shrink-0 text-text-muted">
          {stored ? (
            <>
              {fmt(remaining)}
              {unit ? <span className="ml-0.5 text-[10px]">（{unit}）</span> : null}
            </>
          ) : (
            <>
              {translate("remaining {remaining} of {total}")
                .replace("{remaining}", fmt(remaining))
                .replace("{total}", fmt(total))}
              {row.resetAt ? ` · ${word} ${shortDate(row.resetAt)}` : ""}
            </>
          )}
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

  // Cycle rows (滚动/月度/每周) are rendered as their own fixed-order blocks by
  // classifyCycleRows; only the MONTHLY one can additionally join the additive
  // pool when a pack family coexists (its reset day acts as the pool's expiry).
  const cycle = classifyCycleRows(withNums);
  const monthly = cycle.monthly;

  // Non-recurring rows: same-base-name groups with ≥2 members are a pack
  // family; singletons are stored-value pools (余额/代金券) → meter rows.
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

  // Additive pool (签到积分型 + Qoder 系列积分): family packs + the monthly
  // window (当家族存在时并入) + stored-value singletons (余额/代金券/套餐内
  // Credits——用户拍板：Qoder 也用同一逻辑，都是积分). Rolling/weekly windows
  // are limits, not additive — they never join the pool.
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
      {/* Line 1: icon + 大号余额（无「剩余」二字）←→ X / 共 T */}
      {pool.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <CreditIcon className="size-[13px] text-primary" />
            <b className="text-xl font-bold text-text">{fmt(poolRemaining)}</b>
          </span>
          <span className="inline-flex items-center text-xs tabular-nums text-text-muted">
            {fmt(poolRemaining)} / {fmt(poolTotal)}
          </span>
        </div>
      )}
      {/* Additive pool bar: family packs + monthly (月度并入聚合，不单独成行) */}
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
            <span className="inline-flex min-w-0 items-center gap-2 truncate text-text-muted">
              <span className="truncate">
                {translateQuotaName(displayPackName(soonestLive.name))}
              </span>
              <span>
                （{fmt(soonestLive.remainingNum)}）{translate("expires")} {shortDate(soonestLive.resetAt)}
              </span>
            </span>
          </div>
        );
      })()}

      {/* 储值类（余额/代金券/现金）：同样是「一项两行」，但右侧是单值 + 小字
          单位 —— 它们恒为 X/X，显示 "/ 总量" 没有信息量。 */}
      {singletonPools.length > 0 && (
        <>
          {singletonPools.map((p, i) => (
            <QuotaRow key={`${p.name || "pool"}-${i}`} row={p} />
          ))}
        </>
      )}

      {/* Cycle windows in a fixed order — 滚动 → 月度 → 每周 — each as its own
          two-line block. The monthly slot stays in place as a 0% placeholder
          when the account has no monthly window, so "no monthly allowance" and
          "row missing" are distinguishable at a glance. */}
      {cycle.hasAnyCycle && (
        <>
          {cycle.rolling && <QuotaRow row={cycle.rolling} />}
          {cycle.monthly ? (
            <QuotaRow row={cycle.monthly} />
          ) : cycle.monthlyPlaceholder ? (
            // Placed on a 0–100 scale so the bar renders empty ("0%") rather
            // than dividing by zero.
            <QuotaRow row={{ name: translate("Monthly"), totalNum: 100, remainingNum: 0 }} />
          ) : null}
          {cycle.weekly && <QuotaRow row={cycle.weekly} />}
          {/* Recurring rows whose names matched no cycle bucket still render, so
              nothing ever disappears silently. */}
          {cycle.unmatched.map((p, i) => (
            <QuotaRow key={`${p.name || "win"}-${i}`} row={p} />
          ))}
        </>
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
