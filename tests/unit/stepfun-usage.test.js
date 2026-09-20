import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const ACCOUNTS_URL = "https://api.stepfun.com/v1/accounts";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("stepfun registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("stepfun");
    expect(USAGE_APIKEY_PROVIDERS).toContain("stepfun");
  });
});

describe("getUsageForProvider(stepfun)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns message when apiKey is missing", async () => {
    const res = await getUsageForProvider({ provider: "stepfun" });
    expect(res.message).toMatch(/API key not available/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("handles 401/403 authentication failure", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("", { status: 401 }));

    const res = await getUsageForProvider({
      provider: "stepfun",
      apiKey: "sk-invalid",
    });
    expect(res.plan).toBe("StepFun");
    expect(res.message).toMatch(/authentication failed/i);
  });

  it("parses balance and vouchers properly", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        object: "account",
        type: "prepaid",
        balance: 25.5,
        total_cash_balance: 10.5,
        total_voucher_balance: 15.0,
      }),
    );

    const res = await getUsageForProvider({
      provider: "stepfun",
      apiKey: "sk-test",
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(ACCOUNTS_URL);
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer sk-test");

    expect(res.plan).toBe("StepFun");
    expect(res.quotas["Balance (CNY)"]).toEqual({
      used: 0,
      total: 25.5,
      remainingPercentage: 100,
      resetAt: null,
      displayRemaining: true,
      unlimited: false,
    });
    expect(res.quotas["Cash (CNY)"]).toEqual({
      used: 0,
      total: 10.5,
      remainingPercentage: 100,
      resetAt: null,
      displayRemaining: true,
      unlimited: false,
    });
    expect(res.quotas["Voucher (CNY)"]).toEqual({
      used: 0,
      total: 15.0,
      remainingPercentage: 100,
      resetAt: null,
      displayRemaining: true,
      unlimited: false,
    });
  });

  it("handles zero balance as insufficient balance", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        object: "account",
        type: "prepaid",
        balance: 0,
        total_cash_balance: 0,
        total_voucher_balance: 0,
      }),
    );

    const res = await getUsageForProvider({
      provider: "stepfun",
      apiKey: "sk-test",
    });

    expect(res.plan).toBe("StepFun (Insufficient Balance)");
    expect(res.quotas["Balance (CNY)"]?.total).toBe(0);
    expect(res.quotas["Balance (CNY)"]?.remainingPercentage).toBe(0);
  });
});

describe("parseQuotaData(stepfun)", () => {
  it("forwards remainingPercentage and displayRemaining for balance rows", () => {
    const rows = parseQuotaData("stepfun", {
      plan: "StepFun",
      quotas: {
        "Balance (CNY)": {
          used: 0,
          total: 25.5,
          remainingPercentage: 100,
          displayRemaining: true,
        },
      },
    });
    expect(rows[0]).toMatchObject({
      name: "Balance (CNY)",
      total: 25.5,
      remainingPercentage: 100,
      displayRemaining: true,
    });
  });
});
