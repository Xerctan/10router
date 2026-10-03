import { describe, it, expect } from "vitest";
import { isOversizedForCbcn, describeCbcnOversize, CBCN_PAYLOAD_LIMITS } from "../../open-sse/executors/codebuddy-cn.js";
import { buildErrorBody, unavailableResponse } from "../../open-sse/utils/error.js";

describe("CodeBuddy CN oversized payload pre-check", () => {
  it("detects payload with too many messages", () => {
    const normal = { messages: Array.from({ length: 100 }, () => ({ role: "user", content: "hi" })) };
    expect(isOversizedForCbcn(normal)).toBe(false);

    const oversized = { messages: Array.from({ length: CBCN_PAYLOAD_LIMITS.maxMessages + 10 }, () => ({ role: "user", content: "hi" })) };
    expect(isOversizedForCbcn(oversized)).toBe(true);
  });

  it("does NOT reject tool-heavy-but-small bodies (2026-10-03 回归)", () => {
    // 工具数从未与体积分离验证过(09-17 的 11128 样本是 4.5MB/1676 条/54 工具整体
    // 失败);真实 Claude Code/codex 会话挂 MCP 工具集轻松过 60 个工具、体积适中,
    // 旧的一刀切把 cbcn 从这两类客户端里整个锁死。工具数只进诊断信息。
    const toolHeavy = {
      messages: Array.from({ length: 50 }, () => ({ role: "user", content: "hi" })),
      tools: Array.from({ length: 140 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })),
    };
    expect(isOversizedForCbcn(toolHeavy)).toBe(false);
    // 诊断信息仍报告工具数,供后续上游行为校准。
    expect(describeCbcnOversize(toolHeavy)).toContain("140 个工具");
  });

  it("detects payload exceeding byte size threshold", () => {
    const bigContent = "a".repeat(3.5 * 1024 * 1024);
    const oversized = { messages: [{ role: "user", content: bigContent }] };
    expect(isOversizedForCbcn(oversized)).toBe(true);
    expect(describeCbcnOversize(oversized)).toContain("MB >");
  });

  it("handles null or non-object body safely", () => {
    expect(isOversizedForCbcn(null)).toBe(false);
    expect(isOversizedForCbcn(undefined)).toBe(false);
    expect(isOversizedForCbcn("string")).toBe(false);
  });
});

describe("Error body shape compatibility", () => {
  it("buildErrorBody includes top-level type: error for Claude / Anthropic client compatibility", () => {
    const body = buildErrorBody(400, "test bad request");
    expect(body.type).toBe("error");
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe("test bad request");
  });

  it("unavailableResponse includes top-level type: error", async () => {
    const res = unavailableResponse(503, "channel blocked", new Date(Date.now() + 60000).toISOString(), "reset after 60s");
    const json = await res.json();
    expect(json.type).toBe("error");
    expect(json.error.message).toContain("channel blocked");
  });
});
