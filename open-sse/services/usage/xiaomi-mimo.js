/**
 * Xiaomi MiMo usage — weekly quota + billing balance, both from the account session.
 *
 * Weekly: GET {mimo-server}/api/user/usage authorized by the mimopc account-session
 * cookie (see shared/mimoAccount.js). Response: { code: 0, data: { percent (remaining
 * %), resetDate, resetAt } }.
 *
 * Balance: GET {platform}/api/v1/balance on the web console's api-platform session
 * (same passport cookie, different SSO scope). Response: { code: 0, data: { balance,
 * giftBalance, cashBalance, frozenBalance, currency } } — CNY amounts as strings.
 *
 * Fallback: the sk- API key cannot read the quota, so when no account session is
 * available we surface a graceful message instead of failing.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { getMimoAccountUsage, getMimoAccountBalance } from "../../shared/mimoAccount.js";

const USAGE_URL = "https://aistudio.xiaomimimo.com/open-apis/v1/user/usage";

/**
 * @param {string|null|undefined} accessToken - sk- API key
 * @param {object|null} providerSpecificData - may contain mimoPassToken, uid, etc.
 * @param {object|null} proxyOptions
 */
export async function getXiaomiMimoUsage(accessToken = null, providerSpecificData = null, proxyOptions = null) {
  // Preferred path: both rows come from the account session (mimopc for the weekly
  // quota, api-platform for the balance) — the sk- key can reach neither. The
  // sessions are derived from MiMo Desktop's persisted passToken via the SSO/sts
  // handshakes, cached per passToken.
  const [account, balance] = await Promise.all([
    getMimoAccountUsage(providerSpecificData, proxyOptions),
    getMimoAccountBalance(providerSpecificData, proxyOptions),
  ]);

  const quotas = {};
  if (typeof account.percent === "number" && Number.isFinite(account.percent)) {
    quotas.Weekly = toWeeklyQuota(account.percent, account.resetAt, account.resetDate);
  }
  if (typeof balance.balance === "number" && Number.isFinite(balance.balance)) {
    quotas[`Balance (${balance.currency || "CNY"})`] = toBalanceQuota(balance);
  }
  if (Object.keys(quotas).length) return { plan: "Xiaomi MiMo Desktop", quotas };

  // Fallback: no account session available (Desktop never logged in, or its cookie
  // store is locked). The sk- key cannot read the quota, so surface a clear message.
  const key = accessToken || providerSpecificData?.apiKey;
  if (!key || typeof key !== "string" || !key.trim()) {
    return { message: "Xiaomi MiMo Desktop not connected. Add credentials to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          "X-Mimo-Source": "mimocode-cli",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      },
      proxyOptions,
    );

    if (response.status === 401) {
      return {
        plan: "Xiaomi MiMo Desktop",
        message: "Weekly quota requires Xiaomi account session. API key alone is insufficient.",
      };
    }

    if (!response.ok) {
      return { plan: "Xiaomi MiMo Desktop", message: `Usage API error (${response.status})` };
    }

    const data = await response.json().catch(() => null);
    if (!data || data.code !== 0 || !data.data) {
      return { plan: "Xiaomi MiMo Desktop", message: "Usage endpoint returned unexpected response." };
    }

    const { percent, resetDate, resetAt } = data.data;
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      return { plan: "Xiaomi MiMo Desktop", message: "Usage data missing percent field." };
    }

    return { plan: "Xiaomi MiMo Desktop", quotas: { Weekly: toWeeklyQuota(percent, resetAt, resetDate) } };
  } catch (error) {
    return { message: `Xiaomi MiMo Desktop usage error: ${error.message}` };
  }
}

/**
 * Cash pot for the platform balance (CNY). Mirrors the DeepSeek balance shape:
 * full-remaining against the current pot, never an absolute `remaining` (the
 * QuotaTable reads that field as a 0–100 percentage).
 * @param {{balance:number, gift?:number|null, cash?:number|null, currency?:string}} b
 */
function toBalanceQuota(b) {
  const total = Math.max(0, b.balance);
  return {
    used: 0,
    total,
    remainingPercentage: total > 0 ? 100 : 0,
    resetAt: null,
    unlimited: total > 0,
  };
}

/**
 * Normalize the account-service payload into the dashboard's quota shape.
 * `percent` is the REMAINING percentage (94 means 94% left).
 * @param {number} percent
 * @param {number|string|undefined} resetAt — epoch seconds
 * @param {string|undefined} resetDate — "YYYY-MM-DD"
 */
function toWeeklyQuota(percent, resetAt, resetDate) {
  const remaining = Math.max(0, Math.min(100, Math.round(percent)));
  let resetIso = null;
  if (typeof resetAt === "number" && resetAt > 0) {
    resetIso = new Date(resetAt * 1000).toISOString();
  } else if (typeof resetDate === "string" && resetDate) {
    const parsed = new Date(`${resetDate}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) resetIso = parsed.toISOString();
  }
  return {
    used: 100 - remaining,
    total: 100,
    remainingPercentage: remaining,
    resetAt: resetIso,
    unlimited: false,
  };
}
