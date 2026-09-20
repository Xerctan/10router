/**
 * StepFun usage — GET https://api.stepfun.com/v1/accounts
 * Auth: Bearer <apiKey>
 *
 * Response format:
 * {
 *   "object": "account",
 *   "type": "prepaid",
 *   "balance": 14.97,
 *   "total_cash_balance": 0.0,
 *   "total_voucher_balance": 14.97
 * }
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const ACCOUNTS_URL = "https://api.stepfun.com/v1/accounts";

/**
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 */
export async function getStepfunUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "StepFun API key not available. Add a key to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      ACCOUNTS_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        plan: "StepFun",
        message: "StepFun authentication failed. Check the API key.",
      };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        plan: "StepFun",
        message: `StepFun account API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
      };
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return { message: "StepFun account response was not JSON." };
    }

    const balance = toFiniteNumber(data.balance, 0);
    const cash = toFiniteNumber(data.total_cash_balance, 0);
    const voucher = toFiniteNumber(data.total_voucher_balance, 0);

    const isAvailable = balance > 0;
    const quotas = {};

    quotas["Balance (CNY)"] = {
      used: 0,
      total: Math.max(0, balance),
      remainingPercentage: balance > 0 ? 100 : 0,
      resetAt: null,
      displayRemaining: true,
      unlimited: false,
    };

    if (voucher > 0 && cash > 0) {
      quotas["Cash (CNY)"] = {
        used: 0,
        total: Math.max(0, cash),
        remainingPercentage: cash > 0 ? 100 : 0,
        resetAt: null,
        displayRemaining: true,
        unlimited: false,
      };
      quotas["Voucher (CNY)"] = {
        used: 0,
        total: Math.max(0, voucher),
        remainingPercentage: voucher > 0 ? 100 : 0,
        resetAt: null,
        displayRemaining: true,
        unlimited: false,
      };
    } else if (voucher > 0) {
      quotas["Voucher (CNY)"] = {
        used: 0,
        total: Math.max(0, voucher),
        remainingPercentage: voucher > 0 ? 100 : 0,
        resetAt: null,
        displayRemaining: true,
        unlimited: false,
      };
    }

    return {
      plan: isAvailable ? "StepFun" : "StepFun (Insufficient Balance)",
      quotas,
    };
  } catch (error) {
    return { message: `StepFun error: ${error.message}` };
  }
}
