// Qoder per-resource-pack breakdown via the WEB console endpoint.
//
// The openapi quota endpoint only exposes an aggregate addOnQuota; the per-pack
// list with real expiry lives at {web}/api/v2/me/usages/big_model_credits and
// accepts ONLY the browser session cookie (device/job tokens get 401).
// CreditDaddy captures that cookie and ships it in providerSpecificData on
// account sync. getQoderUsage must prefer this exact breakdown over the
// campaign approximation, cross-check the owner, and fall back cleanly when the
// session is missing / dead / mismatched.
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = [];
const proxyAwareFetch = vi.fn(async (url, opts = {}) => {
  calls.push({ url, headers: opts.headers || {} });
  if (url.includes("/api/v2/quota/usage")) {
    return { ok: true, status: 200, json: async () => ({
      userId: "u-1", userQuota: { total: 0, used: 0, remaining: 0, unit: "credits" },
      addOnQuota: { total: 900, used: 876, remaining: 24, unit: "credits" },
      totalUsagePercentage: 0.98, isQuotaExceeded: false, expiresAt: 253402214400000,
    }) };
  }
  if (url.includes("/api/v2/me/usages/big_model_credits")) {
    if (opts.headers?.Cookie === "dead-session") return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({
      user_id: "u-1",
      resource_package_quota: { quota_detail: [
        { limit_value: 100, used_value: 76, remaining_value: 24, expires_at: 1792635167844, source: "RESOURCE_PACKAGE_SOURCE_BONUS" },
        { limit_value: 500, used_value: 500, remaining_value: 0, expires_at: 1790783939000, source: "RESOURCE_PACKAGE_SOURCE_BONUS" },
        { limit_value: 0, used_value: 0, remaining_value: 0, expires_at: 0, source: "PLAN" },
      ] },
    }) };
  }
  if (url.includes("/sash/api/v1/me/campaigns")) {
    return { ok: true, status: 200, json: async () => ({ campaigns: [
      { claimStatus: "CLAIMED", benefit: { kind: "CREDITS", amount: 100, validity: { mode: "RELATIVE_DAYS", days: 30 } }, startAt: 1790000000 },
    ] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const load = async () => {
  const mod = await import("../../open-sse/services/usage/misc.js");
  return mod.getQoderUsage;
};

describe("getQoderUsage — web per-pack breakdown (CreditDaddy synced cookie)", () => {
  beforeEach(() => { calls.length = 0; proxyAwareFetch.mockClear(); });

  it("prefers the web packs over the campaign approximation when a session is present", async () => {
    const getQoderUsage = await load();
    const out = await getQoderUsage("dt-token", null, "qoder-cn", {
      userId: "u-1",
      creditDaddyWebSession: { cookie: "session=abc", capturedAt: "2026-09-30T11:47:56.904Z", userId: "u-1" },
    });
    const packs = out.quotas.addOn.packs;
    // Real per-pack values (not the soonest-first campaign guess): the 500 pack
    // is fully used, the 100 pack has 24 left, the zero-total PLAN row is dropped.
    expect(packs.map((p) => p.total)).toEqual([500, 100]);
    expect(packs.find((p) => p.total === 100).remaining).toBe(24);
    expect(packs.find((p) => p.total === 100).used).toBe(76);
    expect(packs.every((p) => p.expiresAt)).toBe(true);
    // Exact breakdown → no synthetic "unitemized" remainder row.
    expect(packs.some((p) => p.unitemized)).toBe(false);
    // CN cookie goes to the CN web host, not openapi.
    const webCall = calls.find((c) => c.url.includes("big_model_credits"));
    expect(webCall.url).toBe("https://qoder.cn/api/v2/me/usages/big_model_credits");
    expect(webCall.headers.Cookie).toBe("session=abc");
    // Campaign endpoint must NOT be consulted when the web path succeeds.
    expect(calls.some((c) => c.url.includes("/campaigns"))).toBe(false);
  });

  it("falls back to the campaign approximation without a session", async () => {
    const getQoderUsage = await load();
    const out = await getQoderUsage("dt-token", null, "qoder", null);
    expect(calls.some((c) => c.url.includes("big_model_credits"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/campaigns"))).toBe(true);
    expect(out.quotas.addOn.packs.length).toBeGreaterThan(0);
  });

  it("falls back when the synced session is dead (401)", async () => {
    const getQoderUsage = await load();
    const out = await getQoderUsage("dt-token", null, "qoder", {
      userId: "u-1",
      creditDaddyWebSession: { cookie: "dead-session", userId: "u-1" },
    });
    // Web call failed → campaign path still produced packs; nothing throws.
    expect(calls.some((c) => c.url.includes("big_model_credits"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/campaigns"))).toBe(true);
    expect(Array.isArray(out.quotas.addOn.packs)).toBe(true);
  });

  it("rejects a session whose web user_id does not match the connection owner", async () => {
    const getQoderUsage = await load();
    await getQoderUsage("dt-token", null, "qoder", {
      userId: "someone-else",
      creditDaddyWebSession: { cookie: "session=abc", userId: "someone-else" },
    });
    // The mock web response carries user_id u-1 → mismatch → packs ignored,
    // campaign fallback used instead. (Guard against a stale/misbound cookie
    // showing another account's resource packs.)
    expect(calls.some((c) => c.url.includes("big_model_credits"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/campaigns"))).toBe(true);
  });
});
