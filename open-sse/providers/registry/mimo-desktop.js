import { CLAUDE_API_HEADERS } from "../shared.js";

// MiMo Desktop — the account-session card for Xiaomi MiMo.
//
// Split out of `xiaomi-mimo` (2026-09-22) so the three Xiaomi surfaces are
// separate cards: `xiaomi-mimo` (browser sign-in + sk- key), this one (the
// Desktop account session), and `xiaomi-tokenplan` (tp- subscription key with
// region selection).
//
// What makes this card different is where the credential comes from. Its models
// are served by the account service on mimo-server-cn.xiaomimimo.com and
// authorized by the Xiaomi ACCOUNT SESSION cookie — not by an sk- key. That
// cookie is read on demand from MiMo Desktop's own Electron cookie store
// (see open-sse/shared/mimoAccount.js), so the router never stores it: the
// connection here exists to identify the account/route, and the executor swaps
// in the live cookie per request.
//
// Connection shape: connecting with no sk- key stores the placeholder accessToken
// `mimo-desktop-session[-<uid>]`, which the dashboard reads as "session account,
// no key" (see the api-key route and ConnectionRow).
//
// The executor picks its session path from the PROVIDER id, not the model id, so
// the two ids mapped to it in executors/index.js stay honest: `mimo-desktop`
// spends Desktop credits through the account service while `xiaomi-mimo` bills the
// cloud API — even though both cards list `mimo-v2.6-pro`.
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
  // The account-session path rebuilds its own URL (account-service route) in the
  // executor, so these transports are only the declared shape; they mirror the
  // base card so a mis-routed call still lands on a valid host.
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
    // The Desktop plan's model list. `rateMultiplier` is the credit rate the
    // Desktop app itself prints beside each entry (积分倍率): usage there is metered
    // in credits, so Pro spends 1× and Flash 0.4×. ModelRow renders it as the
    // "Credit multiplier" badge.
    //
    // Same ids as the base card on purpose — they are the same models, and the
    // PROVIDER is what tells the two apart: `xiaomi-mimo/mimo-v2.6-pro` bills the
    // cloud API, `mimo-desktop/mimo-v2.6-pro` spends Desktop credits through the
    // account service. That route accepts only OpenAI format.
    // requiresSession marks "only accepts the MiMo Desktop account cookie"; the
    // dashboard model row renders the "desktop sign-in required" badge from it.
    { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", rateMultiplier: 1, supportedFormats: ["openai"], requiresSession: true },
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", rateMultiplier: 0.4, supportedFormats: ["openai"], requiresSession: true },
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
