import { describe, it, expect } from "vitest";
import { QoderExecutor } from "../../open-sse/executors/qoder.js";
import {
  QODER_CN_GATEWAY_BASE,
  QODER_CN_QUOTA_USAGE_URL,
  QODER_CN_LOGIN_URL,
  QODER_CN_DEVICE_TOKEN_URL,
  QODER_CN_USERINFO_URL,
  QODER_CN_JOB_TOKEN_EXCHANGE_URL,
} from "../../open-sse/shared/qoder/constants.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import qoderCnOAuth from "../../src/lib/oauth/providers/qoder-cn.js";
import { getQoderUsage } from "../../open-sse/services/usage/misc.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("qoder-cn provider registry & capabilities", () => {
  const reg = REGISTRY.find((p) => p.id === "qoder-cn");

  it("exists in registry with alias qdc", () => {
    expect(reg).toBeDefined();
    expect(reg.alias).toBe("qdc");
    expect(reg.category).toBe("oauth");
    expect(PROVIDERS["qoder-cn"]).toBeDefined();
    expect(PROVIDER_MODELS.qdc).toBeDefined();
    expect(PROVIDER_MODELS.qdc.length).toBeGreaterThan(0);
  });

  it("resolves capabilities for qoder-cn models without falling back to default", () => {
    const caps = getCapabilitiesForModel("qoder-cn", "qmodel_latest");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(65536);

    const glm = getCapabilitiesForModel("qoder-cn", "gm51model");
    expect(glm.reasoning).toBe(true);
    expect(glm.contextWindow).toBe(1000000);
    expect(glm.maxOutput).toBe(48000);

    const dmodel = getCapabilitiesForModel("qoder-cn", "dmodel");
    expect(dmodel.reasoning).toBe(true);
    expect(dmodel.contextWindow).toBe(1000000);
  });
});

describe("QoderExecutor (CN deployment)", () => {
  const executor = new QoderExecutor("qoder-cn", QODER_CN_GATEWAY_BASE);

  it("builds URL pointing to gateway.qoder.com.cn for CN deployment", () => {
    const url = executor.buildUrl({ accessToken: "dt-test-device-token" });
    expect(url).toContain("gateway.qoder.com.cn");
    expect(url).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });

  it("builds URL pointing to gateway.qoder.com.cn for job tokens", () => {
    const url = executor.buildUrl({ accessToken: "jt-test-job-token" });
    expect(url).toContain("gateway.qoder.com.cn");
    expect(url).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });
});

describe("qoder-cn OAuth configuration", () => {
  it("points to qoder.com.cn endpoints", () => {
    expect(qoderCnOAuth.config.loginUrl).toBe(QODER_CN_LOGIN_URL);
    expect(qoderCnOAuth.config.deviceTokenUrl).toBe(QODER_CN_DEVICE_TOKEN_URL);
    expect(qoderCnOAuth.config.userInfoUrl).toBe(QODER_CN_USERINFO_URL);
    expect(qoderCnOAuth.flowType).toBe("device_code");
  });

  it("maps tokens with displayName and providerSpecificData", () => {
    const mapped = qoderCnOAuth.mapTokens({
      access_token: "dt-token",
      refresh_token: "rt-token",
      expires_in: 86400,
      _qoderUserId: "uid-123",
      _qoderMachineId: "mid-456",
      _qoderName: "TestUser",
      _qoderEmail: "user@example.com",
      _qoderOrganizationId: "org-789",
    });

    expect(mapped.accessToken).toBe("dt-token");
    expect(mapped.email).toBe("user@example.com");
    expect(mapped.displayName).toBe("TestUser");
    expect(mapped.providerSpecificData.userId).toBe("uid-123");
    expect(mapped.providerSpecificData.machineId).toBe("mid-456");
  });
});

describe("qoder and qoder-cn quota normalization", () => {
  it("normalizes user and addOn quota (resource package) and skips empty org", () => {
    const raw = {
      quotas: {
        user: { total: 0, used: 0, remaining: 0, unit: "credits" },
        addOn: { total: 600, used: 0, remaining: 600, unit: "credits" },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    };

    const cnNormalized = parseQuotaData("qoder-cn", raw);
    expect(cnNormalized).toHaveLength(2);
    expect(cnNormalized[0].name).toBe("Subscription");
    expect(cnNormalized[0].total).toBe(0);
    expect(cnNormalized[1].name).toBe("Resource Package");
    expect(cnNormalized[1].total).toBe(600);

    const intlNormalized = parseQuotaData("qoder", {
      quotas: {
        user: { total: 0, used: 0, remaining: 0, unit: "credits" },
        addOn: { total: 100, used: 0, remaining: 100, unit: "credits" },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    });
    expect(intlNormalized).toHaveLength(2);
    expect(intlNormalized[0].name).toBe("Subscription");
    expect(intlNormalized[1].name).toBe("Resource Package");
    expect(intlNormalized[1].total).toBe(100);
  });
});
