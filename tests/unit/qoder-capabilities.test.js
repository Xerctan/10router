import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  DEFAULT_CAPABILITIES,
  PROVIDER_CAPABILITIES,
  getCapabilitiesForModel,
} from "../../open-sse/providers/capabilities.js";

const qoder = REGISTRY.find((p) => p.id === "qoder");
const qoderCn = REGISTRY.find((p) => p.id === "qoder-cn");

// 虚拟档（auto/efficient）的钉住形状：与 ultimate/performance 同形状的保守超集。
const VIRTUAL_TIER_SHAPE = {
  vision: true,
  reasoning: true,
  thinkingFormat: "claude-adaptive",
  thinkingCanDisable: false,
  contextWindow: 1000000,
  maxOutput: 128000,
};

describe("qoder / qoder-cn capability rows", () => {
  for (const entry of [qoder, qoderCn]) {
    const provider = entry.id;
    const rows = PROVIDER_CAPABILITIES[provider];

    it(`${provider}: every registry model id has a provider row (no floor fallback)`, () => {
      for (const m of entry.models) {
        expect(rows[m.id], `${provider}/${m.id} missing provider row`).toBeDefined();
      }
    });

    it(`${provider}: every display name aliases to its internal id row`, () => {
      for (const m of entry.models) {
        if (!m.name || m.name === m.id) continue;
        const byId = getCapabilitiesForModel(provider, m.id);
        expect(
          getCapabilitiesForModel(provider, m.name),
          `${provider}/${m.name}`,
        ).toEqual(byId);
        expect(byId.thinkingCanDisable).toBe(false);
        // 客户端的全限定写法 "provider/<Name>" 同样必须命中 provider 行。
        expect(
          getCapabilitiesForModel(provider, `${provider}/${m.name}`),
          `${provider}/${provider}/${m.name}`,
        ).toEqual(byId);
      }
    });
  }

  it("qoder/Qwen3.8-Max short-circuits the generic *qwen*max* pattern via the provider row", () => {
    const caps = getCapabilitiesForModel("qoder", "Qwen3.8-Max");
    // 通用族 pattern 不声明 thinkingCanDisable（DEFAULT=true，思考可关）；
    // provider 行固定 false（上游 modelConfig 锁死思考，客户端意图被丢弃）。
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps).toEqual(getCapabilitiesForModel("qoder", "qmodel_38max"));
    expect(getCapabilitiesForModel("qoder", "qoder/Qwen3.8-Max")).toEqual(caps);
  });

  it("pins the virtual-tier shape (auto / efficient) on both regions", () => {
    const expected = { ...DEFAULT_CAPABILITIES, ...VIRTUAL_TIER_SHAPE };
    expect(getCapabilitiesForModel("qoder", "auto")).toEqual(expected);
    expect(getCapabilitiesForModel("qoder", "efficient")).toEqual(expected);
    expect(getCapabilitiesForModel("qoder-cn", "auto")).toEqual(expected);
  });
});
