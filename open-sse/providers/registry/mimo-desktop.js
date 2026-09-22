import { CLAUDE_API_HEADERS } from "../shared.js";

// MiMo Desktop — the account-session card for Xiaomi MiMo.
//
// Split out of `xiaomi-mimo` (2026-09-22) so the three Xiaomi surfaces are
// separate cards: `xiaomi-mimo` (browser sign-in + sk- key), this one (the
// Desktop account session), and `xiaomi-tokenplan` (tp- subscription key with
// region selection).
//
// What makes this card different is where the credential comes from. These two
// Preview models are served by the account service on mimo-server-cn.xiaomimimo.com
// and authorized by the Xiaomi ACCOUNT SESSION cookie — not by an sk- key. That
// cookie is read on demand from MiMo Desktop's own Electron cookie store
// (see open-sse/shared/mimoAccount.js), so the router never stores it: the
// connection here exists to identify the account/route, and the executor swaps
// in the live cookie per request.
//
// Connection shape: connecting with no sk- key stores the placeholder accessToken
// `mimo-desktop-session[-<uid>]`, which the dashboard reads as "session account,
// no key" (see the api-key route and ConnectionRow).
//
// Existing combos still saying `xiaomi-mimo/mimo-x-pro-preview` are NOT broken by
// this move: the executor picks its session path from the MODEL id
// (XiaomiMimoExecutor.isPreviewModel), not the provider id, and the registry is
// not a request gate — so both provider ids reach the same account-service route.
// Both ids are mapped to that executor in executors/index.js for exactly this
// reason; do not drop one without checking stored combos.
export default {
  id: "mimo-desktop",
  // Directly under the base card (20) and Token Plan (21): same vendor, same
  // protocol — only the credential surface differs.
  priority: 22,
  alias: "mimo-desktop",
  // `mimo-desktop` was an alias of xiaomi-mimo before the split; `xmd` moved with
  // it. `mimo` deliberately stayed on the base card. Keeping any of these on both
  // entries would make ALIAS_TO_PROVIDER_ID order decide the winner.
  aliases: [
    "xmd",
  ],
  uiAlias: "xmd",
  display: {
    name: "MiMo Desktop",
    icon: "smart_toy",
    color: "#FF6900",
    textIcon: "XMD",
    website: "https://mimo.xiaomimimo.com",
    notice: {
      text: "Account-session models. Requires MiMo Desktop to be installed and signed in on this machine — the session cookie is read from it locally and never stored here. No API key is needed for these models.",
      signupUrl: "https://mimo.xiaomimimo.com/desktop/invite/",
    },
  },
  category: "oauth",
  // Same connect surface as the base card so the existing MiMo flow can create a
  // connection for THIS provider id; the account session above is what actually
  // authorizes the models.
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  serviceKinds: ["llm"],
  transport: {
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    validateUrl: "https://api.xiaomimimo.com/v1/models",
  },
  // The Preview path rebuilds its own URL (account-service route) in the
  // executor, so these are only a fallback shape; they mirror the base card so a
  // mis-routed non-preview call still lands on a valid host.
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    // Desktop-exclusive — served by the account-service route, which only accepts
    // OpenAI format, so supportedFormats pins them to the openai transport.
    // NOTE: 客户端测试专属模型 —— 不在任何公开目录（models.dev / 桌面版自带快照）里，
    // 程序本体也不含，账号服务端侧下发，属正常；来源 = 上游 PR #3921。
    // requiresSession marks "only accepts the MiMo Desktop account cookie"; the
    // dashboard model row renders the "desktop sign-in required" badge from it.
    { id: "mimo-x-pro-preview", name: "MiMo-X-Pro-Preview", upstreamModelId: "xiaomi/mimo-x-pro-preview", supportedFormats: ["openai"], requiresSession: true },
    { id: "mimo-x-flash-preview", name: "MiMo-X-Flash-Preview", upstreamModelId: "xiaomi/mimo-x-flash-preview", supportedFormats: ["openai"], requiresSession: true },
  ],
  features: {
    usage: true,
    // Usage is read through the same account session, so the non-oauth authType
    // must stay usage-eligible.
    usageApikey: true,
  },
  // Same custom ECDH encrypted-callback flow as the base card — it is the same
  // Xiaomi account either way.
  oauth: {
    custom: true,
    authorizeUrl: "https://platform.xiaomimimo.com/authorize",
    callbackParam: "u",
    kn: "mimocode",
  },
};
