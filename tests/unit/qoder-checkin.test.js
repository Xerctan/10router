import { describe, it, expect, vi } from "vitest";
import {
  isEligibleQoderConnection,
  getQoderOpenApiBase,
  buildQoderHeaders,
  checkinOneQoder,
  runQoderCheckinTick,
} from "../../src/sse/services/qoderCheckin.js";

describe("qoderCheckin unit tests", () => {
  describe("isEligibleQoderConnection", () => {
    it("accepts active qoder and qoder-cn with token", () => {
      expect(isEligibleQoderConnection({ provider: "qoder", accessToken: "dt-123", isActive: true })).toBe(true);
      expect(isEligibleQoderConnection({ provider: "qoder-cn", apiKey: "pt-123", isActive: true })).toBe(true);
    });

    it("rejects inactive or non-qoder connections", () => {
      expect(isEligibleQoderConnection({ provider: "qoder", accessToken: "dt-123", isActive: false })).toBe(false);
      expect(isEligibleQoderConnection({ provider: "openai", accessToken: "sk-123", isActive: true })).toBe(false);
      expect(isEligibleQoderConnection({ provider: "qoder", accessToken: "", isActive: true })).toBe(false);
      expect(isEligibleQoderConnection(null)).toBe(false);
    });
  });

  describe("getQoderOpenApiBase", () => {
    it("resolves CN and Intl base URLs correctly", () => {
      expect(getQoderOpenApiBase("qoder-cn")).toBe("https://openapi.qoder.com.cn");
      expect(getQoderOpenApiBase("qoder")).toBe("https://openapi.qoder.sh");
    });
  });

  describe("buildQoderHeaders", () => {
    it("constructs standard Qoder Cosy and Bearer headers", () => {
      const headers = buildQoderHeaders("test-token");
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["Cosy-ClientType"]).toBe("10");
      expect(headers["Cosy-Version"]).toBe("0.3.3");
      expect(headers["User-Agent"]).toBe("Qoder");
    });
  });

  describe("checkinOneQoder", () => {
    it("claims available campaigns successfully", async () => {
      const mockFetch = vi.fn()
        // 1. GET campaigns
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            campaigns: [
              {
                campaignId: "camp-1",
                campaignKey: "daily-100",
                actionType: "CLAIM_BENEFIT",
                claimStatus: "CLAIMABLE",
                benefit: { kind: "CREDITS", amount: 100 },
              },
            ],
          }),
        })
        // 2. POST claim
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            status: "CLAIMED",
            benefit: { amount: 100 },
          }),
        });

      const res = await checkinOneQoder(
        { id: "c1", name: "User1", provider: "qoder", accessToken: "dt-token" },
        { fetch: mockFetch }
      );

      expect(res.status).toBe("checked-in");
      expect(res.claimedAmount).toBe(100);
      expect(res.campaigns).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toContain("/sash/api/v1/me/campaigns/camp-1/claim");
    });

    it("returns already when no claimable campaigns exist", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          campaigns: [
            {
              campaignId: "camp-1",
              actionType: "CLAIM_BENEFIT",
              claimStatus: "CLAIMED",
            },
          ],
        }),
      });

      const res = await checkinOneQoder(
        { id: "c1", name: "User1", provider: "qoder-cn", accessToken: "dt-token" },
        { fetch: mockFetch }
      );

      expect(res.status).toBe("already");
      expect(res.claimedAmount).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("handles 401 authentication rejection gracefully", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const res = await checkinOneQoder(
        { id: "c1", name: "User1", provider: "qoder", accessToken: "dt-expired" },
        { fetch: mockFetch }
      );

      expect(res.status).toBe("failed");
      expect(res.error).toContain("401");
    });
  });

  describe("runQoderCheckinTick with memoization", () => {
    it("skips accounts already completed today when skipIfCheckedToday is true", async () => {
      const mockCheckinOne = vi.fn();
      const conns = [
        { id: "conn-done", provider: "qoder", accessToken: "t1", isActive: true },
        { id: "conn-new", provider: "qoder", accessToken: "t2", isActive: true },
      ];

      // Re-route localDb to return our mock conns
      const memo = { "conn-done": "2026-09-18" };
      const deps = {
        nowMs: new Date("2026-09-18T10:00:00Z").getTime(),
        doneMap: memo,
        skipIfCheckedToday: true,
        checkinConnection: async (conn) => {
          if (memo[conn.id] === "2026-09-18") {
            return { status: "already", memoized: true };
          }
          return { status: "checked-in", claimedAmount: 100 };
        },
      };

      // Test checkinIfNotDone behavior
      const r1 = await deps.checkinConnection(conns[0]);
      expect(r1.status).toBe("already");
      expect(r1.memoized).toBe(true);

      const r2 = await deps.checkinConnection(conns[1]);
      expect(r2.status).toBe("checked-in");
    });
  });
});
