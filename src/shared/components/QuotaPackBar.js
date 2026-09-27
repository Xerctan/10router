"use client";

import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

/**
 * Multi-quota-pack bar — faithful port of CreditDaddy's account-card bar
 * (QoderDaddy src/panel.html creditHtml + .bar/.seg CSS):
 *
 *   剩余 <b>N</b>          X 于 MM-DD 到期 · 已用 U / 共 T     ← credit-line, space-between
 *   [■■■ pack1 ■■ | ■■ pack2 | … | ▒▒ used ▒▒]                ← .bar (5px, gap 2px)
 *
 * Segment widths are PROPORTIONAL to each pack's remaining share of the total
 * (not equal-width); a single dim trailing segment carries the used amount.
 * Non-recurring packs fade with index (--a: max(.45, .85 - i*.05)); recurring
 * windows stay full-strength. Segment title: "name：剩余 X / Y，MM-DD 重置|到期".
 * The meta line sits ABOVE the bar and is space-between (剩余 N on the LEFT).
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

export default function QuotaPackBar({ packs = [], className }) {
  const live = (packs || []).filter(
    (p) => p && typeof p === "object" && (Number(p.total || 0) > 0 || p.remaining != null)
  );
  if (live.length === 0) return null;

  const total = live.reduce((s, p) => s + Number(p.total || 0), 0);
  const used = live.reduce((s, p) => s + Number(p.used || 0), 0);
  const remainingAll = Math.max(0, total - used);
  if (total <= 0) return null;

  // CreditDaddy renders only LIVE packs (remaining > 0) as colored segments;
  // exhausted one-shot packs vanish into the trailing "used" chunk.
  const livePacks = live
    .map((p) => {
      const t = Number(p.total || 0);
      const r = p.remaining !== undefined && p.remaining !== null
        ? Math.max(0, Number(p.remaining))
        : Math.max(0, t - Number(p.used || 0));
      return { ...p, remainingNum: r, totalNum: t };
    })
    .filter((p) => p.remainingNum > 0 && p.totalNum > 0)
    // Expiry order: the soonest-to-die pack leads the bar.
    .sort((a, b) => {
      const ta = a.resetAt ? new Date(a.resetAt).getTime() : Infinity;
      const tb = b.resetAt ? new Date(b.resetAt).getTime() : Infinity;
      return ta - tb;
    });

  // CreditDaddy's opacity ramp indexes the non-recurring live packs.
  let oneShotIdx = 0;
  const withAlpha = livePacks.map((p) => {
    const alpha = p.recurring === true ? 1 : Math.max(0.45, 0.85 - oneShotIdx++ * 0.05);
    return { ...p, alpha };
  });

  // Cap: fold packs beyond MAX_SEGMENTS into one merged live segment (a 40-pack
  // connection would otherwise overflow the bar via min-width accumulation).
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

  // Earliest one-shot live pack drives the right-hand meta ("X 于 MM-DD 到期"),
  // matching CreditDaddy's `soon` pick (recurring windows reset rather than die).
  const soon = withAlpha
    .filter((p) => p.recurring !== true && p.resetAt)
    .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1 tabular-nums">
          <span className="text-text-muted">{translate("Remaining")}</span>
          <b className="font-bold text-text">{fmt(remainingAll)}</b>
        </span>
        <span className="inline-flex min-w-0 items-center gap-1 truncate tabular-nums text-text-muted">
          {soon && (
            <>
              {fmt(soon.remainingNum)} {translate("expires {date} · used {used} of {total}")
                .replace("{date}", shortDate(soon.resetAt))
                .replace("{used}", fmt(used))
                .replace("{total}", fmt(total))}
            </>
          )}
          {!soon && `${translate("Used")} ${fmt(used)} / ${fmt(total)}`}
        </span>
      </div>
      <div
        className="flex w-full gap-[2px] overflow-hidden rounded-[3px] bg-black/10 dark:bg-white/10"
        style={{ height: "5px" }}
        role="img"
        aria-label={translate("{used} of {total} used across {count} packs")
          .replace("{used}", fmt(used))
          .replace("{total}", fmt(total))
          .replace("{count}", String(live.length))}
      >
        {segments.map((p, i) => {
          const share = total > 0 ? p.remainingNum / total : 0;
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
        {used > 0 && (
          <span
            className="block h-full min-w-[3px] bg-black/20 dark:bg-white/20"
            style={{ flex: `${(used / total).toFixed(4)} 1 0` }}
            title={`${translate("Used")} ${fmt(used)}`}
          />
        )}
      </div>
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
