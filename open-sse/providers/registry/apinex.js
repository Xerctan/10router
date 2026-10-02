// APInex — third-party prepaid AI gateway (apinex.bond), OpenAI-compatible.
// Bearer (or x-api-key) auth; chat completions at /v1/chat/completions.
// Base: https://api.apinex.bond/v1
// Fixed catalog (18 models) mirrors GET /api/public/models; free/* models
// probed live with a real key 2026-09-04 (paid models answer 402
// billing_error at $0 balance — Anthropic family excluded from signup bonus
// credits per upstream billing rules). Model ids are vendor-prefixed
// upstream ids ("gpt/5.6-sol") — pass through verbatim, never strip the
// prefix (capabilities lookup keys on the full id, see capabilities.js).
export default {
  id: "apinex",
  alias: "apinex",
  display: {
    name: "APInex",
    icon: "bolt",
    color: "#C9A227",
    textIcon: "AX",
    website: "https://apinex.bond/",
    notice: {
      text: "Prepaid USD-credit gateway with gamified rewards (XP/airdrop). free/* models run on signup bonus credits; Anthropic models need a real top-up (402 otherwise). Third-party reseller — treat as untrusted for sensitive traffic.",
      apiKeyUrl: "https://apinex.bond/register",
      inviteCode: "SLEWP68C",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.apinex.bond/v1/chat/completions",
    validateUrl: "https://api.apinex.bond/v1/models",
  },
  serviceKinds: ["llm"],
  hasFree: true,
  models: [
    { id: "grok/4.6", name: "Grok 4.6" },
    { id: "claude/opus-5", name: "Claude Opus 5" },
    { id: "claude/sonnet-5", name: "Claude Sonnet 5" },
    { id: "gpt/5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt/5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt/5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gemini/3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini/3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "deepseek/v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
    { id: "deepseek/v4-pro-0813", name: "DeepSeek V4 Pro 0813" },
    { id: "glm/5.3-flash", name: "GLM-5.3 Flash" },
    { id: "glm/5.3", name: "GLM-5.3" },
    { id: "kimi/k3", name: "Kimi K3" },
    { id: "free/glm-5.3-flash", name: "GLM-5.3 Flash (Free)" },
    { id: "free/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731 (Free)" },
    { id: "free/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro 0813 (Free)" },
    { id: "free/gpt-5.6-luna", name: "GPT-5.6 Luna (Free)" },
    { id: "free/qwen-3.8-max", name: "Qwen 3.8 MAX (Free)" },
  ],
};
