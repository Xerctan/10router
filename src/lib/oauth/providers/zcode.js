import crypto from "crypto";

// ───────────────────────────────────────────────────────────────────────────
// ZCode (智谱编码套餐) credential helpers — auth-code login + API key minting.
//
// Protocol (verified against zcode-api, which mirrors the ZCode 3.1.x+ client):
//   1. Browser: https://bigmodel.cn/login?appId=zcode&redirect=<callback>&state=<hex>
//   2. Localhost callback captures ?authCode=...&state=...
//   3. POST https://zcode.z.ai/api/v1/oauth/token {provider:"bigmodel", code,
//      redirect_uri, state} → data.bigmodel.access_token (+ data.token JWT,
//      data.user.user_id)
//   4. Mint: bigmodel.cn biz API → find-or-create key named "zcode-api-key"
//      → copy endpoint for the secret → standard key "<apiKey>.<secret>"
//
// The minted key works on the standard open.bigmodel.cn endpoints (same as
// glm-cn). The zcode.z.ai plan endpoints are captcha-gated (3007) and are
// intentionally NEVER called from here.
// ───────────────────────────────────────────────────────────────────────────

const ZCODE_TOKEN_ENDPOINT = "https://zcode.z.ai/api/v1/oauth/token";
const BIGMODEL_HOST = "https://bigmodel.cn";
const BIGMODEL_AUTHORIZE_URL = `${BIGMODEL_HOST}/login`;
const BIGMODEL_APP_ID = "zcode";
const ZAI_HOST = "https://api.z.ai";
const ZAI_LOGIN_URL = `${ZAI_HOST}/api/auth/z/login`;
const ZCODE_API_KEY_NAME = "zcode-api-key";
export const ZCODE_CALLBACK_PATH = "/oauth/callback/bigmodel";
const DEFAULT_ORG_MARKER = "默认组织";
const DEFAULT_PROJECT_MARKER = "默认项目";

export function newZcodeState() {
  return crypto.randomBytes(16).toString("hex");
}

export function buildZcodeAuthorizeUrl(callbackUrl, state) {
  const url = new URL(BIGMODEL_AUTHORIZE_URL);
  url.searchParams.set("appId", BIGMODEL_APP_ID);
  url.searchParams.set("redirect", callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

// Parse a pasted callback URL / query string (paste fallback for headless hosts).
// Accepts the full redirect URL or just its query; returns {authCode, state}.
export function parseZcodeCallback(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Paste the callback URL first.");
  let queryStr = text;
  if (text.includes("?")) queryStr = text.slice(text.indexOf("?") + 1);
  else if (text.includes("=") && !text.includes("/")) queryStr = text;
  else throw new Error("That does not look like the callback URL — copy the full address from the browser after login.");
  const params = Object.fromEntries(new URLSearchParams(queryStr));
  const authCode = params.authCode || params.code || params.authcode;
  if (!authCode) throw new Error("The callback URL has no authCode — redo the browser login and copy the redirected address.");
  const state = params.state || null;
  return { authCode, state };
}

async function zcodeJsonFetch(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = json?.msg || json?.message || json?.error || `HTTP ${res.status}`;
    throw new Error(`ZCode auth failed: ${msg}`);
  }
  return json;
}

// Step 3: exchange the authCode for the provider access token.
export async function exchangeZcodeCode({ code, redirectUri, state }) {
  const json = await zcodeJsonFetch(ZCODE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "bigmodel", code, redirect_uri: redirectUri, state }),
  });
  if (json && typeof json.code === "number" && json.code !== 0) {
    throw new Error(`ZCode auth failed: ${json.msg || `code ${json.code}`}`);
  }
  const data = json?.data || {};
  const providerToken = data?.bigmodel?.access_token;
  if (!providerToken || typeof providerToken !== "string") {
    throw new Error("ZCode auth response has no bigmodel access_token — make sure the account logged in on the bigmodel side.");
  }
  return {
    providerToken,
    jwt: data?.token || null,
    userId: data?.user?.user_id || null,
    provider: "bigmodel",
  };
}

// Shared biz-API request. Returns the unwrapped payload (json.data when the
// envelope has one, else the root object).
async function requestBizApi(url, authorization, options = {}) {
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      ...(options.headers || {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const msg = json?.msg || json?.message || json?.error || `HTTP ${res.status}`;
    throw new Error(`ZCode biz API failed: ${msg}`);
  }
  return json?.data !== undefined ? json.data : json;
}

// Default org/project selection mirrors the ZCode client: prefer the entry
// whose name contains 默认组织/默认项目, fall back to the first.
function resolveCustomerInfo(info) {
  const orgs = info?.organizations ?? info?.orgs ?? [];
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error("ZCode account has no organizations on record.");
  }
  const org = orgs.find((o) => String(o?.organizationName ?? o?.name ?? "").includes(DEFAULT_ORG_MARKER)) ?? orgs[0];
  const orgId = org?.organizationId ?? org?.id ?? org?.orgId;
  if (!orgId) throw new Error("ZCode account organization id missing.");
  const projects = org?.projects ?? [];
  const project = Array.isArray(projects) && projects.length
    ? (projects.find((p) => String(p?.projectName ?? p?.name ?? "").includes(DEFAULT_PROJECT_MARKER)) ?? projects[0])
    : null;
  const projectId = project?.projectId ?? project?.id;
  if (!projectId) throw new Error("ZCode account project id missing.");
  return { orgId, projectId };
}

async function findOrCreateApiKey(authorization, host, orgId, projectId) {
  const listUrl = `${host}/api/biz/v1/organization/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/api_keys`;
  const listed = await requestBizApi(listUrl, authorization);
  const list = Array.isArray(listed) ? listed : (listed?.api_keys ?? listed?.items ?? []);
  const found = Array.isArray(list)
    ? list.find((k) => k?.name === ZCODE_API_KEY_NAME && typeof k.apiKey === "string" && k.apiKey.length > 0)
    : null;
  if (found) return found.apiKey;
  const created = await requestBizApi(listUrl, authorization, { method: "POST", body: { name: ZCODE_API_KEY_NAME } });
  if (typeof created?.apiKey !== "string" || created.apiKey.length === 0) {
    throw new Error("ZCode API key creation returned an unexpected shape (apiKey missing).");
  }
  return created.apiKey;
}

async function getSecretKey(authorization, host, orgId, projectId, apiKey) {
  const url = `${host}/api/biz/v1/organization/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/api_keys/copy/${encodeURIComponent(apiKey)}`;
  try {
    const data = await requestBizApi(url, authorization);
    return data?.secretKey ?? data?.secret_key ?? "";
  } catch {
    // zcode-api parity: a withheld secret degrades to the bare apiKey
    // ("use apiKey only") rather than failing the whole mint.
    return "";
  }
}

// A bigmodel standard key is exactly "<id>.<secret>" (two dot segments, no
// scheme prefix). JWTs (3 segments) and opaque tokens are NOT keys.
export function looksLikeBigmodelKey(token) {
  if (typeof token !== "string") return false;
  const t = token.trim();
  if (!t || t.length > 200 || /\s/.test(t)) return false;
  const parts = t.split(".");
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

// Extract the credential material from one transfer-file account. Accepts the
// plain transfer shape (accessToken holds the token/key) and the CreditDaddy
// shape (accessToken is a "zcode-creds:<uid>" marker; the real material sits
// in meta.credentials, object or array, with bigmodel/zai sub-objects).
// Returns { token, provider, uid } or null when nothing usable is present.
export function pickZcodeImportMaterial(item) {
  const markerToken = typeof item?.accessToken === "string" ? item.accessToken : null;
  if (markerToken && !markerToken.startsWith("zcode-creds:")) {
    return { token: markerToken, provider: item?.provider || null, uid: null };
  }
  const store = item?.meta?.credentials ?? item?.credentials ?? null;
  const entries = Array.isArray(store) ? store : store ? [store] : [];
  // Two passes: an account carrying both sides lands on bigmodel (v1 target),
  // even when the zai entry comes first.
  for (const side of ["bigmodel", "zai"]) {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const inner = entry[side];
      const token = inner?.access_token || inner?.accessToken;
      if (typeof token === "string" && token) {
        return {
          token,
          provider: side,
          uid: entry.userId ?? entry.user_id ?? item?.uid ?? null,
        };
      }
    }
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const direct = entry.access_token || entry.accessToken;
    if (typeof direct === "string" && direct) {
      return { token: direct, provider: entry.provider || item?.provider || null, uid: entry.userId ?? entry.user_id ?? item?.uid ?? null };
    }
  }
  return null;
}

// Bigmodel branch: raw accessToken (no Bearer) against bigmodel.cn.
// Returns { fullKey, userId? } — fullKey = "<apiKey>.<secret>", degrades to
// the bare apiKey when the copy endpoint withholds the secret.
export async function mintBigmodelKey(providerToken) {
  const authorization = String(providerToken).trim();
  const info = await requestBizApi(`${BIGMODEL_HOST}/api/biz/customer/getCustomerInfo`, authorization);
  const { orgId, projectId } = resolveCustomerInfo(info);
  const apiKey = await findOrCreateApiKey(authorization, BIGMODEL_HOST, orgId, projectId);
  const secret = await getSecretKey(authorization, BIGMODEL_HOST, orgId, projectId, apiKey);
  return { fullKey: secret ? `${apiKey}.${secret}` : apiKey };
}

// Z.AI branch (import paths only): access_token → biz token → same biz flow.
// Returns { apiKey, secret } kept separate (the zai key format is not the
// bigmodel id.secret composition).
export async function mintZaiKey(providerToken) {
  const loginJson = await zcodeJsonFetch(ZAI_LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: String(providerToken).trim() }),
  });
  const bizToken = loginJson?.data?.access_token ?? loginJson?.access_token ?? loginJson?.data?.data?.access_token;
  if (!bizToken || typeof bizToken !== "string") {
    throw new Error("Z.AI login did not return a biz access_token.");
  }
  const authorization = `Bearer ${bizToken}`;
  const info = await requestBizApi(`${ZAI_HOST}/api/biz/customer/getCustomerInfo`, authorization);
  const { orgId, projectId } = resolveCustomerInfo(info);
  const apiKey = await findOrCreateApiKey(authorization, ZAI_HOST, orgId, projectId);
  const secret = await getSecretKey(authorization, ZAI_HOST, orgId, projectId, apiKey);
  return { apiKey, secret };
}

// Full browser-login completion: authCode → token → minted standard key.
export async function exchangeAndMintZcode({ code, redirectUri, state }) {
  const exchanged = await exchangeZcodeCode({ code, redirectUri, state });
  const { fullKey } = await mintBigmodelKey(exchanged.providerToken);
  return { fullKey, userId: exchanged.userId, jwt: exchanged.jwt };
}

// Connection row shared by the browser flow and both import paths.
// authType "apikey" (no underscore) is the value the shared importer gates the
// apiKey field on; the executor's combined path reads apiKey||accessToken.
export function buildZcodeConnectionPayload({ fullKey, userId, authMethod }) {
  return {
    provider: "zcode",
    authType: "apikey",
    accessToken: fullKey,
    apiKey: fullKey,
    refreshToken: null,
    expiresAt: null,
    email: userId ? `${userId}@zcode` : null,
    displayName: userId ? `ZCode ${userId}` : "ZCode",
    providerSpecificData: {
      zcodeUserId: userId ?? null,
      zcodeProvider: "bigmodel",
      authMethod: authMethod || "oauth",
    },
    testStatus: "active",
  };
}

// Dedupe matcher: same minted key OR same zcode account (userId), mirroring
// the xiaomiIdentity approach so re-login/re-import updates instead of stacking.
export function findZcodeConnection(connections, { userId, key }) {
  const list = Array.isArray(connections) ? connections : [];
  if (key) {
    const byKey = list.find((c) => (c.apiKey && c.apiKey === key) || c.accessToken === key);
    if (byKey) return byKey;
  }
  if (userId) {
    const byUser = list.find((c) => c?.providerSpecificData?.zcodeUserId === userId);
    if (byUser) return byUser;
  }
  return null;
}
