"use client";

import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

/**
 * Multi-quota-pack segmented bar (visual language ported from CreditDaddy).
 *
 * One segment per quota pack, ordered by expiry (earliest first, like
 * CreditDaddy's left-most segment); each segment fills with the pack's
 * REMAINING fraction — the bar drains as the pack is consumed. Recurring
 * windows (weekly/monthly refills) render in a cooler tone so one-shot bonus
 * packs read apart from them. Depleted packs stay as dim stubs: an empty
 * segment is information (that pack is spent) and dropping it would fatten
 * the survivors.
 *
 * Meta line below mirrors CreditDaddy's "6.09 于 10-11 到期 · 已用 2,502.91 /
 * 共 4,918": the earliest live pack's remaining + reset date, then the
 * connection-wide used/total sums.
 */

const MAX_SEGMENTS = 14;

function packRemaining(quota) {
  if (quota.remaining !== undefined && quota.remaining !== null) return Math.max(0, Number(quota.remaining));
  const total = Number(quota.total || 0);
  const used = Number(quota.used || 0);
  return Math.max(0, total - used);
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

export default function QuotaPackBar({ packs = [], className }) {
  const live = (packs || []).filter(
    (p) => p && typeof p === "object" && (Number(p.total || 0) > 0 || p.remaining != null)
  );
  if (live.length === 0) return null;

  // Earliest-expiry first: the left-most segment is the one about to reset/die,
  // mirroring CreditDaddy's reading order.
  const sorted = [...live].sort((a, b) => {
    const ta = a.resetAt ? new Date(a.resetAt).getTime() : Infinity;
    const tb = b.resetAt ? new Date(b.resetAt).getTime() : Infinity;
    return ta - tb;
  });

  // Overflow packs (beyond MAX_SEGMENTS) collapse into one trailing segment so
  // a 40-pack connection still renders a readable bar.
  let segments = sorted;
  let overflow = null;
  if (sorted.length > MAX_SEGMENTS) {
    segments = sorted.slice(0, MAX_SEGMENTS - 1);
    const rest = sorted.slice(MAX_SEGMENTS - 1);
    overflow = {
      name: translate("{count} more packs").replace("{count}", String(rest.length)),
      used: rest.reduce((s, p) => s + Number(p.used || 0), 0),
      total: rest.reduce((s, p) => s + Number(p.total || 0), 0),
      resetAt: rest[0]?.resetAt || null,
      remaining: rest.reduce((s, p) => s + packRemaining(p), 0),
      isOverflow: true,
    };
  }

  const totalUsed = sorted.reduce((s, p) => s + Number(p.used || 0), 0);
  const totalAll = sorted.reduce((s, p) => s + Number(p.total || 0), 0);
  const earliestLive = sorted.find((p) => {
    const t = p.resetAt ? new Date(p.resetAt).getTime() : Infinity;
    return Number.isFinite(t) && t > Date.now() && packRemaining(p) > 0;
  }) || sorted.find((p) => p.resetAt);

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-center gap-[3px]" role="img"
        aria-label={translate("{used} of {total} used across {count} packs")
          .replace("{used}", fmt(totalUsed))
          .replace("{total}", fmt(totalAll))
          .replace("{count}", String(sorted.length))}>
        {segments.map((p, i) => {
          const total = Number(p.total || 0);
          const remaining = packRemaining(p);
          const frac = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
          const depleted = total > 0 && remaining <= 0;
          const recurring = p.recurring === true;
          return (
            <div
              key={`${p.name || "pack"}-${i}`}
              className="h-[6px] min-w-0 flex-1 overflow-hidden rounded-[3px] bg-black/10 dark:bg-white/10"
              title={[
                p.name || translate("Quota package"),
                `${fmt(remaining)} / ${fmt(total)}`,
                p.resetAt ? `${translate("resets")} ${shortDate(p.resetAt)}` : null,
                recurring ? translate("recurring window") : null,
              ].filter(Boolean).join(" · ")}
            >
              <div
                className={cn(
                  "h-full rounded-[3px] transition-[width] duration-500",
                  depleted
                    ? "w-full bg-black/15 dark:bg-white/15"
                    : recurring
                      ? "bg-sky-500/80"
                      : "bg-green-500/90"
                )}
                style={{ width: `${(depleted ? 1 : frac) * 100}%` }}
              />
            </div>
          );
        })}
        {overflow && (
          <div
            className="h-[6px] w-10 shrink-0 overflow-hidden rounded-[3px] bg-black/10 dark:bg-white/10"
            title={`${overflow.name}: ${fmt(overflow.remaining)} / ${fmt(overflow.total)}`}
          >
            <div
              className="h-full bg-green-500/90"
              style={{ width: `${overflow.total > 0 ? Math.min(100, (overflow.remaining / overflow.total) * 100) : 100}%` }}
            />
          </div>
        )}
      </div>
      {earliestLive && (
        <p className="mt-1 text-right text-[11px] tabular-nums text-text-muted">
          {fmt(packRemaining(earliestLive))}
          {" "}
          {translate("expires {date} · used {used} of {total}")
            .replace("{date}", shortDate(earliestLive.resetAt))
            .replace("{used}", fmt(totalUsed))
            .replace("{total}", fmt(totalAll))}
        </p>
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
