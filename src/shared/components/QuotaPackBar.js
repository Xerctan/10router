"use client";

import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

/**
 * Family-pack segmented bar — faithful port of CreditDaddy's bonus-pack block
 * (QoderDaddy panel.html creditHtml: "积分包 13 个可用…" + Bonus Pack ×N +
 * proportional .bar with a trailing used segment).
 *
 * SEMANTICS (the part that matters): only packs of the SAME family aggregate
 * into a bar. "Bonus Pack 24/25/26…" are interchangeable one-shot packs of one
 * pool → one segmented bar. Different-relationship rows — 余额 vs 代金券
 * (different spending scopes) or 滚动/每周/月度 (independent reset windows) —
 * are NEVER summed: their numbers only make sense per-window, and the table
 * below already renders each of them with its own meter. Aggregate summary
 * rows ("Total Points") are excluded as derived data.
 *
 * Family identity: the row name minus its trailing index ("Bonus Pack 24" →
 * "Bonus Pack"). Groups with ≥2 members render; singletons are left to the
 * table. Multiple families stack as separate blocks.
 */

const MAX_SEGMENTS = 20;

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

const AGGREGATE_RE = /total|aggregate|summary|^总/i;
function familyBase(name) {
  return String(name || "").replace(/\s*\d+\s*$/, "").trim();
}

export default function QuotaPackBar({ packs = [], className }) {
  const rows = (packs || []).filter((p) => p && typeof p === "object" && !AGGREGATE_RE.test(String(p.name || "")));

  // Group by family base name; keep insertion order of first appearance.
  const groups = new Map();
  for (const p of rows) {
    const base = familyBase(p.name);
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(p);
  }

  const families = [...groups.entries()]
    .map(([base, members]) => {
      const withNums = members.map((p) => ({
        ...p,
        remainingNum: remainingOf(p),
        totalNum: Number(p.total || 0),
      }));
      const totalNum = withNums.reduce((s, p) => s + p.totalNum, 0);
      const usedNum = withNums.reduce((s, p) => s + Number(p.used || 0), 0);
      const remainingNum = withNums.reduce((s, p) => s + p.remainingNum, 0);
      // CreditDaddy's `soon`: earliest one-shot live expiry drives the badge.
      const soon = withNums
        .filter((p) => p.recurring !== true && p.resetAt && p.remainingNum > 0)
        .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;
      return { base, members: withNums, totalNum, usedNum, remainingNum, soon, live: withNums.filter((p) => p.remainingNum > 0 && p.totalNum > 0) };
    })
    .filter((f) => f.members.length >= 2 && f.totalNum > 0);

  if (families.length === 0) return null;

  return (
    <div className={cn("min-w-0 space-y-2.5", className)}>
      {families.map((family) => {
        // CreditDaddy renders only LIVE packs (remaining > 0) as colored
        // segments; exhausted ones live on inside the "已用" numbers.
        const livePacks = family.live
          // Expiry order: the soonest-to-die pack leads the bar.
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
              ...rest.reduce((acc, p) => ({
                name: acc.name,
                remainingNum: acc.remainingNum + p.remainingNum,
                totalNum: acc.totalNum + p.totalNum,
                resetAt: acc.resetAt,
                recurring: false,
              }), { name: family.base, remainingNum: 0, totalNum: 0, resetAt: null, recurring: false }),
              alpha: 0.6,
            },
          ];
        }
        const usedShare = family.totalNum > 0 ? family.usedNum / family.totalNum : 0;

        return (
          <div key={family.base} className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-3 text-xs">
              <span className="truncate font-semibold text-text">
                {family.base} <span className="tabular-nums opacity-70">×{family.live.length || family.members.length}</span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 tabular-nums text-text-muted">
                {translate("remaining {remaining} of {total}")
                  .replace("{remaining}", fmt(family.remainingNum))
                  .replace("{total}", fmt(family.totalNum))}
                {family.soon && (
                  <>
                    {" · "}
                    {translate("earliest {date}").replace("{date}", shortDate(family.soon.resetAt))}
                  </>
                )}
              </span>
            </div>
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
