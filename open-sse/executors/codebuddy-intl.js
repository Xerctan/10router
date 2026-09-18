import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    // 11155: upstream rejects the turn whenever reasoning is requested but any PRIOR
    // assistant turn with tool_calls lacks a real (non-empty) reasoning_content.
    // Read from the ORIGINAL body so the guard sees what the client actually sent —
    // super.transformRequest() runs injectReasoningContent, which for DeepSeek
    // (MODEL_RULES /deepseek/i, scope "all") fills a " " placeholder into every
    // unreasoned assistant turn. Note the predicate below already tolerates that
    // placeholder (`" ".trim()` is empty, so `!(…)` is true, keeping the guard live);
    // reading `body` just makes the intent explicit and independent of pre-processing.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    const origin = Array.isArray(body?.messages) ? body.messages : source;
    const hasUnreasonedToolTurn = origin.some(
      (m) => m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && !(typeof m.reasoning_content === "string" && m.reasoning_content.trim())
    );

    // A malformed reasoning_effort (true/{}/[]/0/"") is not a level, and upstream
    // answers it with 400 11150 exactly like "auto". Treat it as absent rather than
    // forwarding it (mirrors the typeof check in opencode.js).
    if (transformed.reasoning_effort !== undefined && typeof transformed.reasoning_effort !== "string") {
      delete transformed.reasoning_effort;
    }

    const eff = transformed.reasoning_effort;
    // 11150: DeepSeek-series models reject reasoning_effort "auto" (400, "reasoning
    // effort value is not supported by the current model"); they accept only
    // low/medium/high/xhigh/max/none. Translate so agent clients (e.g. dsh sending
    // THINK:auto) don't hard-fail: auto → high (keep reasoning; it's the gateway default).
    //
    // Priority when 11150 and 11155 could BOTH apply (DeepSeek + "auto" + a prior
    // unreasoned tool turn): DROP the field. Emitting "high" would clear 11150, but the
    // turn still fails 11155, so dropping is the only outcome satisfying both. The 11155
    // guard therefore deliberately WINS over the auto→high translation — hence
    // `!hasUnreasonedToolTurn` gates the DeepSeek branch below. Every other combination
    // falls through to the guard unchanged.
    const isDeepSeek = typeof model === "string" && /deepseek/i.test(model);
    if (isDeepSeek && eff === "auto" && !hasUnreasonedToolTurn) {
      transformed.reasoning_effort = "high";
      transformed.reasoning_summary = "auto";
    } else if (hasUnreasonedToolTurn || eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
      delete transformed.reasoning_summary;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }
}

export default CodeBuddyIntlExecutor;
