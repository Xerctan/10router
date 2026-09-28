import os from "os";
import crypto from "crypto";
import { readFile } from "fs/promises";
import path from "path";

// Reader for a local ZCode desktop install (~/.zcode/v2). Read-only: config.json
// (plaintext keys) + credentials.json (AES-256-GCM "enc:v1:<nonce>.<tag>.<ct>",
// URL-safe base64, key = sha256 fallback string — same scheme as the community
// zcode-api client, verified against a live install). Injection points make it
// unit-testable without touching the real home directory.

const V2_DIR = path.join(".zcode", "v2");

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(t + "=".repeat((4 - (t.length % 4)) % 4), "base64");
}

export function zcodeCredentialKey({ platform, home, username, envSecret } = {}) {
  if (envSecret) return crypto.createHash("sha256").update(String(envSecret)).digest();
  return crypto
    .createHash("sha256")
    .update(`zcode-credential-fallback:${platform}:${home}:${username}`)
    .digest();
}

// Decrypt one "enc:v1:..." value. Returns the plaintext string or null when the
// value is not an enc:v1 blob / fails to decrypt (wrong host context).
export function decryptZcodeValue(encValue, key) {
  const v = String(encValue || "");
  if (!v.startsWith("enc:v1:")) return null;
  const body = v.slice("enc:v1:".length);
  const parts = body.split(".");
  if (parts.length !== 3) return null;
  try {
    const nonce = unb64url(parts[0]);
    const tag = unb64url(parts[1]);
    const ct = unb64url(parts[2]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// A bigmodel standard key is "<id>.<secret>" — two dot segments.
function looksLikeKey(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (!t || t.length > 200 || /\s/.test(t)) return false;
  const parts = t.split(".");
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

/**
 * Scan a local ZCode v2 install for bigmodel-side credential material.
 * @param {object} [opts] - { dir, platform, home, username, envSecret } overrides (tests).
 * @returns {Promise<{candidates: Array, notes: string[]}>}
 *   candidates: { fullKey, userId, source, kind } — fullKey ready to store.
 *   No network calls: the mint fallback is the route's job (needs the biz API).
 */
export async function readZcodeLocalInstall(opts = {}) {
  const dir = opts.dir || path.join(os.homedir(), V2_DIR);
  const platform = opts.platform ?? os.platform();
  const home = opts.home ?? os.homedir();
  const username = opts.username ?? os.userInfo().username;
  const envSecret = opts.envSecret ?? process.env.ZCODE_CREDENTIAL_SECRET;

  const candidates = [];
  const notes = [];
  let config = null;
  let credentials = null;
  try {
    config = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));
  } catch (e) {
    notes.push(`config.json unreadable: ${e.message}`);
  }
  try {
    credentials = JSON.parse(await readFile(path.join(dir, "credentials.json"), "utf8"));
  } catch (e) {
    notes.push(`credentials.json unreadable: ${e.message}`);
  }
  if (!config && !credentials) {
    return { candidates, notes };
  }

  // 1) Plaintext keys in config.json — only the bigmodel side is usable here;
  //    the z.ai coding key targets api.z.ai endpoints this provider does not serve.
  const providers = config?.provider || config?.providers || {};
  for (const [id, entry] of Object.entries(providers)) {
    if (!id.startsWith("builtin:bigmodel")) continue;
    const key = entry?.options?.apiKey;
    if (looksLikeKey(key)) {
      candidates.push({ fullKey: key.trim(), userId: null, source: `config:${id}`, kind: "bigmodel" });
    }
  }

  if (credentials) {
    const key = zcodeCredentialKey({ platform, home, username, envSecret });
    let userId = null;
    const userInfoValue = credentials["oauth:bigmodel:user_info"];
    const userInfoPlain = decryptZcodeValue(userInfoValue, key);
    if (userInfoPlain) {
      try { userId = JSON.parse(userInfoPlain)?.id ?? null; } catch { /* keep null */ }
    } else if (userInfoValue) {
      notes.push("user_info not decryptable on this host context");
    }

    // 2) Cached minted keys: account-provider:coding-plan:account:*:api-key.
    //    ONLY bigmodel-* accounts — the zai-* siblings hold api.z.ai keys that
    //    do not work on the open.bigmodel.cn endpoints this provider targets.
    let cached = 0;
    for (const [name, value] of Object.entries(credentials)) {
      if (!name.startsWith("account-provider:coding-plan:") || !name.endsWith(":api-key")) continue;
      if (!name.includes(":account:bigmodel-")) {
        notes.push(`skipped non-bigmodel key entry: ${name}`);
        continue;
      }
      const plain = decryptZcodeValue(value, key);
      if (!looksLikeKey(plain)) continue;
      cached++;
      candidates.push({
        fullKey: plain.trim(),
        userId,
        source: `credentials:${name}`,
        kind: "bigmodel",
        // Two entries for the same account (individual/team) may hold the same
        // key; the route dedupes identical keys.
      });
    }

    // 3) Fallback: the provider access_token — needs a mint round-trip.
    let tokenPlain = null;
    if (cached === 0) {
      const tokenValue = credentials["oauth:bigmodel:access_token"];
      tokenPlain = decryptZcodeValue(tokenValue, key);
      if (tokenPlain) {
        candidates.push({ token: tokenPlain.trim(), userId, source: "credentials:oauth:bigmodel:access_token", kind: "bigmodel" });
      } else if (tokenValue) {
        notes.push("access_token not decryptable on this host context");
      }
    }
  }

  // Identical keys from different sources collapse to one candidate.
  const seen = new Set();
  const deduped = candidates.filter((c) => {
    const id = c.fullKey || c.token;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { candidates: deduped, notes };
}
