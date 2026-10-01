// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Google-style quota windows (Antigravity 429 RESOURCE_EXHAUSTED with
// quotaResetDelay) are the account's REAL reset clock — hours by design.
// Honoring them needs a bigger ceiling than the generic 30min hint cap.
export const MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

// Channel-level (provider-wide) block durations (ms).
// Some upstreams reject a *request shape* or an *egress fingerprint* rather than
// an account — CodeBuddy's 11128 "unapproved channel" answers identically for
// every account of the provider within the same second. Locking accounts one by
// one triples the burst, which is itself the signal the WAF looks for, so the
// right response is to stop the whole channel for a while instead.
export const CHANNEL_BLOCK_MS = {
  // First offence: short pause. Long enough that the in-flight request gives up
  // and the client retries into a different provider/model, short enough that a
  // blip does not blackhole the channel.
  short: 60 * 1000,
  // Repeat offence within CHANNEL_BLOCK_ESCALATE_WINDOW_MS: the fingerprint is
  // clearly sticky, back off properly.
  long: 10 * 60 * 1000,
};

// Re-offending inside this window escalates short → long.
export const CHANNEL_BLOCK_ESCALATE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff?, channelScope?, provider? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 *   - channelScope: true = the failure is a property of the CHANNEL (egress
 *     fingerprint / request shape), not of the account, so the caller must stop
 *     retrying sibling accounts and cool the whole provider down instead.
 *   - provider: 限定规则只对该 provider（解析后的 id）生效——同一句错误文案
 *     在别的渠道可能是请求自身的问题，不该把账号拉进长冷却。
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  // codex：[1m] 长上下文请求打到没勾选该变体的账号时，后端 400 回复这句——
  // 是账号级能力问题（换号可解），但它以 400 出现会撞进下方「请求自身 4xx
  // 不冷却」的兜底分支，所以必须显式置顶并按长冷却换下一个账号（上游 9f41ee75）。
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  // CodeBuddy 11128 "Illegal API invocation from an unapproved channel" —
  // upstream security policy. Verified on a 4-account pool: all four answer 11128
  // with the SAME model within the same second (323–654ms), while a direct
  // single request with the identical shape returns 200. So the block is on the
  // channel, and walking the account list is what makes it worse.
  { text: "unapproved channel",       channelScope: true, cooldownMs: CHANNEL_BLOCK_MS.short },
  { text: "illegal api invocation",   channelScope: true, cooldownMs: CHANNEL_BLOCK_MS.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  // Missing MiMo Desktop session is a CONFIGURATION state (executors/xiaomi-mimo.js),
  // not a transient fault: cooldown 0 = account never locked, combo falls through
  // immediately with zero wait, and the client sees the friendly message without
  // a misleading "(reset after 30s)".
  { text: "mimo desktop account",     cooldownMs: 0 },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
