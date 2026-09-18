import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

/**
 * Xiaomi MiMo account-session helpers (used for weekly quota).
 *
 * The weekly quota endpoint lives on the account service domain and is authorized
 * by an account session cookie, NOT the sk- API key. Acquiring that cookie mirrors
 * MiMo Desktop: a passToken (persisted in Desktop's cookie store) is exchanged via
 * the passportapi SSO, then authorized for the `mimopc` service, and finally stamped
 * by the mimo-server /api/sts callback into a `serviceToken` cookie.
 *
 * Flow (verified against MiMo Desktop traffic):
 *   1. GET  {api}/api/user/xiaomi/me           -> 302 to account SSO (sid=mimopc)
 *   2. GET  account /pass/serviceLogin?sid=passportapi&_json=true   -> nonce/ssecurity
 *   3. GET  {location}&clientSign=...          -> account-level serviceToken
 *   4. GET  account /pass/serviceLogin?sid=mimopc&callback=<sts>&_json=true
 *   5. GET  {api}/api/sts?...&ticket...        -> Set-Cookie: serviceToken (mimopc scope)
 */

const API_BASE = "https://mimo-server-cn.xiaomimimo.com";
const ACCOUNT_HOST = "account.xiaomi.com";
const API_UA =
  "miNative PC/Normal Windows_NT/10.0.19045 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0";
const SSO_UA = "MiClaw/1.0";
const COOKIE_TTL_MS = 30 * 60 * 1000;
// After a failed handshake, don't re-walk the SSO chain on every dashboard poll:
// Xiaomi's passport risk control step-ups (captcha / interactive login) when it
// sees repeated serviceLogin attempts, so hammering makes an outage permanent.
// Negative-cache the failure for a cooldown window instead.
const SSO_BACKOFF_MS = 10 * 60 * 1000;
// Console sessions live for days in a browser; re-handshaking every 30min only
// risks the step-up above. Stale sessions are caught by the 401 re-handshake.
const PLATFORM_TTL_MS = 12 * 60 * 60 * 1000;
// Windows surfaces a sharing violation on the Desktop's cookie db as EBUSY;
// POSIX gives EACCES/EPERM (or EBUSY under flock).
const LOCKED_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

// Per-account session caches (keyed by passToken hash) so multiple Xiaomi
// accounts / connections can rotate without clobbering each other.
const _cache = new Map(); // key -> { cookie, at }
const _inflight = new Map(); // key -> Promise<cookie|null>
// Platform (api-platform) sessions are a separate cookie scope from the mimo-server
// (mimopc) session, so they get their own cache — an account may hold both at once.
const _platformCache = new Map();
const _platformInflight = new Map();

// ─── MiMo Desktop on-disk layout ───────────────────────────────────────────
// MiMo Desktop is an Electron app and keeps TWO independent stores:
//   • its Electron profile  — the Chromium cookie DB holding the passToken
//   • its credential dir    — the auth.json its bundled engine reads/writes
// They live in different roots, so they are resolved separately — but both in
// this one module, so the two can never drift apart.

const DESKTOP_APP_NAME = "Xiaomi MiMo";

/**
 * MiMo Desktop's Electron userData dir (Chromium profile root).
 * Windows honours APPDATA (redirected/roaming profiles), macOS uses Library and
 * Linux follows XDG_CONFIG_HOME — Electron's own per-platform resolution.
 */
export function desktopUserDataDir() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), DESKTOP_APP_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", DESKTOP_APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), DESKTOP_APP_NAME);
}

/**
 * MiMo Desktop's account-partition cookie DB (holds the passToken).
 * A running Desktop holds it with an exclusive lock — see readDesktopPassToken().
 */
export function desktopCookiePath() {
  return path.join(desktopUserDataDir(), "Partitions", "xiaomi-account", "Network", "Cookies");
}

/**
 * Where MiMo Desktop keeps auth.json — NOT inside its Electron profile.
 *
 * Desktop starts its bundled engine with `authDataDir: Vs`, where
 *   Vs = $XDG_DATA_HOME/mimocode  ||  ~/.local/share/mimocode
 * i.e. the XDG *data* dir on every platform — macOS included, no ~/Library here.
 * The standalone mimocode CLI is retired, but it wrote to this same dir, so one
 * path covers both and no CLI-specific candidate exists.
 *
 * When XDG_DATA_HOME is set the default location is still listed second: a user
 * who changed the variable after signing in keeps a working fallback.
 *
 * @returns {string[]} candidates, most authoritative first
 */
export function desktopAuthJsonPaths() {
  const home = os.homedir();
  const fallback = path.join(home, ".local", "share", "mimocode");
  const xdg = process.env.XDG_DATA_HOME;
  const primary = xdg ? path.join(xdg, "mimocode") : fallback;
  const dirs = primary === fallback ? [primary] : [primary, fallback];
  return dirs.map((dir) => path.join(dir, "auth.json"));
}

/**
 * Read the persisted Xiaomi account cookies from MiMo Desktop's Electron profile.
 * The Chromium cookie DB is held with an exclusive lock while Desktop runs, so we
 * copy it first and bail (return null) if that fails.
 *
 * The copy holds a live account session, so it is created owner-only (0600) and is
 * always unlinked again — a stray copy in the shared temp dir would be a credential
 * leak on a multi-user machine.
 *
 * @returns {Promise<Record<string,string>|null>}
 */
async function readDesktopAccountCookies() {
  const src = desktopCookiePath();
  if (!fs.existsSync(src)) return null;
  const tmp = path.join(os.tmpdir(), `10router-mimo-cookies-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`);
  try {
    fs.copyFileSync(src, tmp);
  } catch (err) {
    // A running Xiaomi MiMo Desktop keeps an *exclusive* lock on its cookie db:
    // on Windows even a plain read fails (EBUSY, verified against the installed
    // client), so there is nothing to read around. Surface it as a typed error
    // instead of pretending the session is absent — otherwise "quit the app" is
    // indistinguishable from "never signed in", and both look like a silent no-op.
    if (LOCKED_CODES.has(err?.code)) {
      const locked = new Error("Xiaomi MiMo Desktop is holding its cookie store (quit the app and retry)");
      locked.code = "DESKTOP_LOCKED";
      throw locked;
    }
    return null; // missing/unreadable for any other reason
  }
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort — no-op on Windows */
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    // The handle must be closed on every path: on Windows an open handle keeps the
    // file locked, the unlink below fails silently, and a copy of the account cookie
    // db would be left behind in the shared temp dir.
    let db = null;
    try {
      db = new DatabaseSync(tmp, { readOnly: true });
      const rows = db.prepare("SELECT name, value FROM cookies WHERE host_key = ?").all("." + ACCOUNT_HOST);
      const jar = Object.fromEntries(rows.map((r) => [r.name, r.value]));
      return jar.passToken ? jar : null;
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null;
  } finally {
    await unlinkQuietly(tmp);
  }
}

/** Best-effort removal of the temp copy (retried: AV/indexers can hold it briefly). */
async function unlinkQuietly(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.unlinkSync(file);
      return;
    } catch (err) {
      if (err.code === "ENOENT") return;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 20));
    }
  }
}

/**
 * Read just the passToken + identity cookies from Desktop's profile.
 * Exported so the connect flow can persist a per-account passToken into the
 * connection's providerSpecificData — this is what enables multi-account rotation.
 * @returns {Promise<{passToken:string, userId:string|null, cUserId:string|null}|null>}
 */
export async function readDesktopPassToken() {
  try {
    const jar = await readDesktopAccountCookies();
    if (!jar?.passToken) return null;
    return { passToken: jar.passToken, userId: jar.userId || null, cUserId: jar.cUserId || null };
  } catch (err) {
    // Let the callers tell "locked" apart from "no session" and act on it.
    if (err?.code === "DESKTOP_LOCKED") throw err;
    return null;
  }
}

function signatureClientSign(nonce, ssecurity) {
  const input = `nonce=${nonce}` + (ssecurity && ssecurity.trim() ? `&${ssecurity}` : "");
  return encodeURIComponent(crypto.createHash("sha1").update(input).digest("base64"));
}

function absorbSetCookie(jar, res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = /^([^=]+)=([^;]*)/.exec(c.trim());
    if (m && m[2]) jar[m[1]] = m[2];
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Exchange a passToken for a mimo-server service session cookie.
 * @returns {Promise<string|null>} Cookie header value, or null on failure.
 */
async function acquireServiceCookie(passJar, proxyOptions) {
  const jar = { ...passJar };
  const ck = () => cookieHeader(jar);

  // 1. Unauthenticated API call -> 302 carrying the sts callback (sid=mimopc)
  // Every step carries a hard 10s timeout: the connection-test path awaits this
  // whole chain, and one hung SSO hop used to freeze the dashboard's Test
  // spinner indefinitely (the outer 15s probe timeout never gets reached).
  const r1 = await proxyAwareFetch(
    `${API_BASE}/api/user/xiaomi/me`,
    { redirect: "manual", headers: { "User-Agent": API_UA, Cookie: ck() }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  const redirect = r1.headers.get("location");
  if (!redirect) return null;
  const stsCallback = new URL(redirect).searchParams.get("callback");
  if (!stsCallback) return null;

  // 2. passportapi SSO phase 1 -> nonce + ssecurity
  const sso1 = await proxyAwareFetch(
    `https://${ACCOUNT_HOST}/pass/serviceLogin?sid=passportapi&_json=true`,
    { headers: { Cookie: ck(), "User-Agent": SSO_UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  const j1 = JSON.parse((await sso1.text()).replace(/^&&&START&&&/, ""));
  const nonce = j1.nonce || (j1.location ? new URL(j1.location).searchParams.get("nonce") : null);
  if (!nonce || !j1.location) return null;

  // 3. passportapi SSO phase 2 -> account-level serviceToken
  const sso2 = await proxyAwareFetch(
    `${j1.location}&clientSign=${signatureClientSign(nonce, j1.ssecurity)}`,
    { redirect: "manual", headers: { Cookie: ck(), "User-Agent": SSO_UA }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  absorbSetCookie(jar, sso2);

  // 4. mimopc SSO -> sts callback carrying a ticket
  const sso3 = await proxyAwareFetch(
    `https://${ACCOUNT_HOST}/pass/serviceLogin?sid=mimopc&callback=${encodeURIComponent(stsCallback)}&_json=true`,
    { headers: { Cookie: ck(), "User-Agent": SSO_UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  const j3 = JSON.parse((await sso3.text()).replace(/^&&&START&&&/, ""));
  absorbSetCookie(jar, sso3);
  if (!j3?.location || !/\/api\/sts/.test(j3.location)) return null;

  // 5. sts callback -> Set-Cookie: serviceToken (mimopc scope)
  const sts = await proxyAwareFetch(
    j3.location,
    { redirect: "manual", headers: { "User-Agent": API_UA, Cookie: ck() }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  absorbSetCookie(jar, sts);

  const needed = ["serviceToken", "mimopc_ph", "mimopc_slh", "userId"];
  if (!jar.serviceToken) return null;
  const out = {};
  for (const k of needed) if (jar[k]) out[k] = jar[k];
  return cookieHeader(out);
}

/**
 * Resolve the passport cookie jar for an account: per-connection `mimoPassToken`
 * override first (multi-account rotation), else MiMo Desktop's persisted session.
 * @returns {Promise<{jar?:object, reason?:string}>}
 */
async function resolvePassJar(providerSpecificData) {
  if (providerSpecificData?.mimoPassToken) {
    return {
      jar: {
        passToken: providerSpecificData.mimoPassToken,
        userId: providerSpecificData.mimoUserId,
        cUserId: providerSpecificData.mimoCUserId,
      },
    };
  }
  try {
    const jar = await readDesktopAccountCookies();
    return jar ? { jar } : { reason: "no-pass-token" };
  } catch (err) {
    // Usage must degrade, never throw — but keep the reason diagnosable.
    if (err?.code === "DESKTOP_LOCKED") return { reason: "desktop-locked" };
    throw err;
  }
}

/**
 * Get (and cache) the mimo-server account cookie.
 * @param {object|null} providerSpecificData - may carry `mimoPassToken` override
 */
async function getServiceCookie(providerSpecificData, proxyOptions) {
  const { jar: passJar, reason } = await resolvePassJar(providerSpecificData);
  if (!passJar) return { cookie: null, reason };

  // One cached session per passToken — accounts/connections rotate independently.
  const key = crypto.createHash("sha256").update(passJar.passToken).digest("hex");

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < (cached.cookie ? COOKIE_TTL_MS : SSO_BACKOFF_MS)) {
    return cached.cookie ? { cookie: cached.cookie } : { cookie: null, reason: "sso-failed" };
  }

  // De-dupe concurrent handshakes for the same account: a burst of requests must
  // not each run the full 5-step SSO chain.
  const inflight = _inflight.get(key);
  if (inflight) {
    const cookie = await inflight;
    return cookie ? { cookie } : { cookie: null, reason: "sso-failed" };
  }

  const promise = (async () => {
    try {
      return await acquireServiceCookie(passJar, proxyOptions);
    } catch {
      return null; // network/parse failure — callers degrade, never throw
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);

  const cookie = await promise;
  if (!cookie) {
    _cache.set(key, { cookie: null, at: Date.now() }); // backoff: don't re-walk immediately
    return { cookie: null, reason: "sso-failed" };
  }
  _cache.set(key, { cookie, at: Date.now() });
  return { cookie };
}

/** Drop cached sessions so the next call re-runs the handshake (e.g. after a 401). */
export function invalidateMimoAccountCookieCache() {
  _cache.clear();
  _platformCache.clear();
}

/** mimo-server account API base + the User-Agent its backend expects. */
export const MIMO_API_BASE = API_BASE;
export const MIMO_API_UA = API_UA;

/**
 * Resolve the mimo-server account-session cookie, for upstream /api/route/* calls.
 * @returns {Promise<string|null>} Cookie header value, or null when unavailable.
 */
export async function getMimoAccountCookie(providerSpecificData = null, proxyOptions = null) {
  try {
    const { cookie } = await getServiceCookie(providerSpecificData, proxyOptions);
    return cookie;
  } catch {
    return null;
  }
}

// ─── Platform console session (billing balance) ────────────────────────────────
// The web console API (platform.xiaomimimo.com/api/v1/balance) is authorized by a
// browser session cookie, sid=api-platform — a different scope from the mimopc
// weekly-quota session above. Its 401 body hands us the serviceLogin loginUrl;
// walking that chain with the passport jar stamps `api-platform_*` session cookies
// that unlock the balance API. (Verified live 2026-09-18.)

const PLATFORM_BASE = "https://platform.xiaomimimo.com";
// The console sits behind MiFE and answered the browser fetch as a normal web app;
// mimic a desktop Chrome — the passport endpoints keyed off the app UA never apply
// on this leg of the chain.
const PLATFORM_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const PLATFORM_COOKIE_KEYS = ["api-platform_serviceToken", "api-platform_ph", "api-platform_slh", "userId"];

/**
 * Walk the api-platform SSO chain: 401 -> loginUrl -> serviceLogin -> sts.
 * @returns {Promise<string|null>} Cookie header for the platform session, or null.
 */
async function acquirePlatformCookie(passJar, proxyOptions) {
  const r0 = await proxyAwareFetch(
    `${PLATFORM_BASE}/api/v1/balance`,
    { headers: { Accept: "application/json", "User-Agent": PLATFORM_UA }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  const j0 = await r0.json().catch(() => null);
  let url = j0 && j0.loginUrl;
  if (!url) return null;

  const jar = { ...passJar };
  for (let hop = 0; hop < 5 && url; hop++) {
    const res = await proxyAwareFetch(
      url,
      {
        redirect: "manual",
        headers: { Cookie: cookieHeader(jar), Accept: "*/*", "User-Agent": PLATFORM_UA },
        signal: AbortSignal.timeout(10000),
      },
      proxyOptions,
    );
    absorbSetCookie(jar, res);
    // The session is minted once sts stamps api-platform_serviceToken — stop there.
    // Walking the followup would re-GET the balance API carrying the passport jar
    // (a browser never sends the account-scoped passToken to the platform origin).
    if (jar["api-platform_serviceToken"]) break;
    const loc = res.headers.get("location");
    url = loc ? new URL(loc, url).href : null;
  }
  if (!jar["api-platform_serviceToken"]) return null;
  const out = {};
  for (const k of PLATFORM_COOKIE_KEYS) if (jar[k]) out[k] = jar[k];
  return cookieHeader(out);
}

/**
 * Get (and cache) the platform.xiaomimimo.com session cookie (per passToken).
 */
async function getPlatformCookie(providerSpecificData, proxyOptions) {
  const { jar: passJar, reason } = await resolvePassJar(providerSpecificData);
  if (!passJar) return { cookie: null, reason };

  const key = crypto.createHash("sha256").update(passJar.passToken).digest("hex");
  const cached = _platformCache.get(key);
  if (cached && Date.now() - cached.at < (cached.cookie ? PLATFORM_TTL_MS : SSO_BACKOFF_MS)) {
    return cached.cookie ? { cookie: cached.cookie, key } : { cookie: null, reason: "sso-failed", key };
  }

  const inflight = _platformInflight.get(key);
  if (inflight) {
    const cookie = await inflight;
    return cookie ? { cookie, key } : { cookie: null, reason: "sso-failed" };
  }

  const promise = (async () => {
    try {
      return await acquirePlatformCookie(passJar, proxyOptions);
    } catch {
      return null; // network/parse failure — callers degrade, never throw
    } finally {
      _platformInflight.delete(key);
    }
  })();
  _platformInflight.set(key, promise);

  const cookie = await promise;
  if (!cookie) {
    _platformCache.set(key, { cookie: null, at: Date.now() }); // backoff: don't re-walk immediately
    return { cookie: null, reason: "sso-failed", key };
  }
  _platformCache.set(key, { cookie, at: Date.now() });
  return { cookie, key };
}

function toMoney(v) {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch the account's billing balance from the platform console.
 * @returns {Promise<{balance?:number, gift?:number, cash?:number, frozen?:number, currency?:string, error?:string}>}
 */
export async function getMimoAccountBalance(providerSpecificData = null, proxyOptions = null) {
  let { cookie, key, reason } = await getPlatformCookie(providerSpecificData, proxyOptions);
  if (!cookie) {
    return { error: reason === "no-pass-token" || reason === "desktop-locked" ? "no-session" : "session-failed" };
  }

  const read = async (ck) => {
    const res = await proxyAwareFetch(
      `${PLATFORM_BASE}/api/v1/balance`,
      {
        headers: { Accept: "application/json", "User-Agent": PLATFORM_UA, Cookie: ck, "X-Timezone": "Asia/Shanghai" },
        signal: AbortSignal.timeout(10000),
      },
      proxyOptions,
    );
    if (res.status === 401) return { auth: false };
    if (!res.ok) return { error: `http-${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || data.code !== 0 || !data.data) return { error: "bad-response" };
    return { data: data.data };
  };

  let out = await read(cookie);
  if (out.auth === false) {
    // Server-side session died inside our 30-min cache window — one re-handshake.
    _platformCache.delete(key);
    ({ cookie, key } = await getPlatformCookie(providerSpecificData, proxyOptions));
    if (!cookie) return { error: "session-failed" };
    out = await read(cookie);
    if (out.auth === false) return { error: "session-failed" };
  }
  if (out.error) return { error: out.error };
  const d = out.data;
  return {
    balance: toMoney(d.balance),
    gift: toMoney(d.giftBalance),
    cash: toMoney(d.cashBalance),
    frozen: toMoney(d.frozenBalance),
    currency: typeof d.currency === "string" && d.currency ? d.currency.toUpperCase() : "CNY",
  };
}

/**
 * Fetch the weekly quota from the account service.
 * @returns {Promise<{percent?:number, resetDate?:string, resetAt?:number, error?:string}>}
 */
export async function getMimoAccountUsage(providerSpecificData = null, proxyOptions = null) {
  const { cookie, reason } = await getServiceCookie(providerSpecificData, proxyOptions);
  if (!cookie) {
    return { error: reason === "no-pass-token" || reason === "desktop-locked" ? "no-session" : "session-failed" };
  }
  try {
    const res = await proxyAwareFetch(
      `${API_BASE}/api/user/usage`,
      { headers: { "User-Agent": API_UA, Cookie: cookie, Accept: "application/json" }, signal: AbortSignal.timeout(10000) },
      proxyOptions,
    );
    if (!res.ok) return { error: `http-${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || data.code !== 0 || !data.data) return { error: "bad-response" };
    return { percent: data.data.percent, resetDate: data.data.resetDate, resetAt: data.data.resetAt };
  } catch (e) {
    return { error: e.message };
  }
}
