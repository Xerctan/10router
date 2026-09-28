import { CLAUDE_API_HEADERS } from "../shared.js";

// ZCode (智谱编码套餐) — the GLM coding-plan entitlement behind the ZCode client.
// OAuth login (auth-code flow) mints a standard bigmodel API key ("zcode-api-key",
// id.secret) via the biz API; completions then run on the SAME standard endpoints
// as glm-cn — never on zcode.z.ai plan endpoints, which are captcha-gated (3007)
// and intentionally out of scope. The minted/pasted key is a normal bigmodel key:
// long-lived, no refresh flow exists upstream.
export default {
  id: "zcode",
  priority: 135,
  alias: "zcode",
  display: {
    name: "ZCode",
    icon: "code",
    color: "#7C3AED",
    textIcon: "ZC",
    website: "https://bigmodel.cn",
    notice: {
      apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    },
  },
  // Dual auth like kimi: OAuth = browser login (mints the key), API key = paste
  // an existing bigmodel/coding-plan key.
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    usage: {
      url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    },
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  // Mirrors the ZCode 3.11.2 coding-plan catalog (zcode-api parity).
  models: [
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash (Vision)" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5v-turbo", name: "GLM 5V Turbo (Vision)" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-4.7", name: "GLM-4.7" },
    { id: "glm-4.6", name: "GLM-4.6" },
    { id: "glm-4.6v", name: "GLM 4.6V (Vision)" },
    { id: "glm-4.5-air", name: "GLM-4.5-Air" },
  ],
  features: {
    usage: true,
    usageApikey: true,
  },
};
