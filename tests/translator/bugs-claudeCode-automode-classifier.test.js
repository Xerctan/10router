// Issue #18: Claude Code auto mode (xml_2stage classifier) fails through the
// gateway when traffic routes to a non-Claude model (reporter: HTTP 200 but
// deepseek-v4.1-flash via CodeBuddy CN answered without the expected XML).
//
// Per the triage plan (docs/zh-CN/impl-plan-issue24-25-agent.md, appendix A):
// before closing as upstream-model non-compliance, rule out ADAPTER
// INTERFERENCE with a direct-vs-gateway byte comparison of classifier-shaped
// traffic. This file is the offline half of that comparison: it pins the exact
// pipeline CC classifier traffic takes through the gateway —
//
//   CC (claude) → translateRequest(claude→openai) → CodeBuddyExecutor
//               .transformRequest → upstream
//   upstream (openai SSE) → translateResponse(openai→claude) → CC
//
// — and proves it is byte-faithful for classifier-shaped prompts/answers:
//
//   1. A classifier system prompt WITHOUT agent-identity markers survives both
//      hops verbatim: the XML output instructions are neither truncated nor
//      rewritten, user turns pass unchanged, and the model's answer (XML or
//      prose) reaches the client byte-for-byte — the gateway never "repairs"
//      or damages it. → If the reporter's classifier prompt reached upstream
//      intact, the non-XML answer is purely the model's own output, and the
//      fix is client-side (compliant model for the classifier slot, or auto
//      mode off).
//
//   2. THE ONE gateway-side path that CAN strip the instructions is documented
//      below: the cbcn WAF workaround (open-sse/executors/codebuddy-cn.js,
//      transformRequest) replaces system prompts matching AGENT_PATTERN —
//      e.g. anything carrying the "You are Claude Code, Anthropic's official
//      CLI" identity preamble — with a neutral prompt, XML instructions
//      included. If CC's auto-mode classifier call carries that preamble, this
//      replacement alone reproduces the reported symptom (200 + non-XML).
//      Which case the reporter hit is decidable ONLY from their raw classifier
//      request (the requestDetails byte capture offered in the issue thread);
//      the workaround itself must stay — without it Tencent's WAF rejects the
//      whole request (11128/11129-class blocks), which is strictly worse.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import CodeBuddyExecutor from "../../open-sse/executors/codebuddy-cn.js";

const T = (src, tgt, body, provider = "codebuddy-cn") =>
  translateRequest(src, tgt, "deepseek-v4.1-flash", body, true, null, provider);

// Representative auto-mode classifier prompt: pure task instructions, no CLI
// identity. The XML contract is what xml_2stage parses on the client side.
const XML_INSTRUCTIONS = `You are a task complexity classifier.
Respond ONLY with valid XML — no prose, no markdown fences — in exactly this format:
<classification>
<complexity>low|medium|high</complexity>
<thinking_needed>true|false</thinking_needed>
</classification>`;

// The same instructions behind Claude Code's stock identity preamble — the
// shape that trips the cbcn WAF workaround.
const IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";

function classifierBody(systemText) {
  return {
    system: [{ type: "text", text: systemText }],
    messages: [
      { role: "user", content: "Classify this task: refactor the auth middleware <and> keep tests green." },
    ],
    max_tokens: 200,
    stream: true,
  };
}

function systemOf(messages) {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string"
    ? sys.content
    : Array.isArray(sys.content)
      ? sys.content.map((b) => b?.text || "").join("\n")
      : "";
}

// Run openai-shaped upstream SSE events through the response translator the
// way chatCore does for a claude-format client, collecting every text_delta.
function runResponseStream(events) {
  const state = initState(FORMATS.CLAUDE);
  const out = [];
  for (const ev of events) {
    const r = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, ev, state);
    if (Array.isArray(r)) out.push(...r);
    else if (r) out.push(r);
  }
  return out;
}

function collectClaudeText(events) {
  let text = "";
  for (const ev of events) {
    if (ev?.type === "content_block_delta" && ev?.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      text += ev.delta.text;
    }
  }
  return text;
}

describe("issue #18: classifier request fidelity (claude → openai → cbcn executor)", () => {
  const executor = new CodeBuddyExecutor();

  it("XML output instructions survive translateRequest byte-for-byte", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(XML_INSTRUCTIONS));
    const sys = systemOf(out.messages);
    expect(sys).toContain(XML_INSTRUCTIONS);
    expect(sys).toContain("<classification>");
    expect(sys).toContain("</classification>");
  });

  it("cbcn executor leaves the identity-free classifier prompt untouched", () => {
    const translated = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(XML_INSTRUCTIONS));
    const before = systemOf(translated.messages);
    const transformed = executor.transformRequest("deepseek-v4.1-flash", translated, true, {});
    expect(systemOf(transformed.messages)).toBe(before); // byte-identical
    expect(transformed.stream).toBe(true); // forceStream quirk, orthogonal to content
  });

  it("user turn (with angle brackets) passes through both hops verbatim", () => {
    const translated = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(XML_INSTRUCTIONS));
    const transformed = executor.transformRequest("deepseek-v4.1-flash", translated, true, {});
    const user = transformed.messages.find((m) => m.role === "user");
    const text = typeof user.content === "string" ? user.content : user.content.map((b) => b?.text || "").join("");
    expect(text).toContain("refactor the auth middleware <and> keep tests green.");
  });

  // DOCUMENTED INTERFERENCE PATH (intended WAF workaround, not a bug to fix
  // blindly): open-sse/executors/codebuddy-cn.js transformRequest — system
  // prompts matching AGENT_PATTERN are replaced wholesale with NEUTRAL_PROMPT.
  // A classifier prompt carrying the CC identity preamble loses its XML
  // contract here — and the model, never told to emit XML, answers prose:
  // exactly the reporter's symptom (HTTP 200, non-XML output). Settling whether
  // CC's auto-mode classifier carries the preamble needs the reporter's raw
  // request bytes; removing the workaround is NOT an option (Tencent's WAF
  // rejects identity-carrying prompts outright — the whole request dies).
  it("identity-prefixed classifier prompt is neutralized by the cbcn WAF workaround", () => {
    const translated = T(FORMATS.CLAUDE, FORMATS.OPENAI, classifierBody(`${IDENTITY_PREFIX}\n\n${XML_INSTRUCTIONS}`));
    const transformed = executor.transformRequest("deepseek-v4.1-flash", translated, true, {});
    const sys = systemOf(transformed.messages);
    expect(sys).toBe(NEUTRAL_PROMPT);
    expect(sys).not.toContain("<classification>");
  });
});

describe("issue #18: classifier response fidelity (openai SSE → claude)", () => {
  it("conforming XML output reaches the client byte-for-byte", () => {
    const xml = "<classification>\n<complexity>high</complexity>\n<thinking_needed>true</thinking_needed>\n</classification>";
    // split mid-tag to prove no chunk-boundary mangling
    const events = [
      { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: xml.slice(0, 30) } }] },
      { id: "c1", choices: [{ index: 0, delta: { content: xml.slice(30) } }] },
      { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    expect(collectClaudeText(runResponseStream(events))).toBe(xml);
  });

  it("non-XML prose passes through verbatim — the gateway never repairs output", () => {
    const prose = "Sure! This task is HIGH complexity because it touches middleware and tests. You should enable thinking.";
    const events = [
      { id: "c2", choices: [{ index: 0, delta: { role: "assistant", content: prose.slice(0, 40) } }] },
      { id: "c2", choices: [{ index: 0, delta: { content: prose.slice(40) } }] },
      { id: "c2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    expect(collectClaudeText(runResponseStream(events))).toBe(prose);
  });

  it("terminal stop_reason survives for the classifier turn", () => {
    const events = [
      { id: "c3", choices: [{ index: 0, delta: { content: "<classification/>" } }] },
      { id: "c3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const out = runResponseStream(events);
    const md = out.find((e) => e?.type === "message_delta");
    expect(md?.delta?.stop_reason).toBeTruthy();
  });
});
