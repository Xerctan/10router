import { describe, it, expect } from "vitest";
import { formatResetTime, parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { extractEarliestPackageExpiry } from "../../open-sse/services/usage/expiryExtractor.js";

describe("Qoder usage & sentinel timestamp display", () => {
  it("formatResetTime should return '-' for sentinel dates beyond 2099", () => {
    // Year 9999 sentinel
    const farFuture = "9999-12-31T00:00:00.000Z";
    expect(formatResetTime(farFuture)).toBe("-");

    const year3000 = new Date("3000-01-01T00:00:00.000Z");
    expect(formatResetTime(year3000)).toBe("-");
  });

  it("parseQuotaData should normalize Qoder 0 credits without sentinel expiry", () => {
    const rawQoderUsage = {
      userId: "test-user",
      userType: "personal_standard",
      usageType: "credits",
      totalUsagePercentage: 0.0,
      isQuotaExceeded: true,
      expiresAt: 253402214400000,
      quotas: {
        user: {
          total: 0,
          used: 0,
          remaining: 0,
          unit: "credits",
          resetAt: "9999-12-31T00:00:00.000Z",
          unlimited: false,
        },
      },
    };

    const parsed = parseQuotaData("qoder", rawQoderUsage);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Plan Credits");
    expect(parsed[0].total).toBe(0);
    expect(parsed[0].used).toBe(0);
    expect(parsed[0].resetAt).toBeNull();
    expect(parsed[0].unlimited).toBe(false);
  });

  it("extractEarliestPackageExpiry should ignore sentinel dates beyond 2099", () => {
    const usage = {
      quotas: {
        Personal: {
          total: 100,
          used: 10,
          remaining: 90,
          resetAt: "9999-12-31T00:00:00.000Z",
        },
      },
    };

    const result = extractEarliestPackageExpiry(usage);
    expect(result).toBeNull();
  });
});
