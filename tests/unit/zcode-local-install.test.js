/**
 * readZcodeLocalInstall — scans a fixture ~/.zcode/v2 (config.json +
 * credentials.json) using the real enc:v1 AES-256-GCM scheme. No network, no
 * real home directory: platform/home/username are injected.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  decryptZcodeValue,
  readZcodeLocalInstall,
  zcodeCredentialKey,
} from "../../src/lib/oauth/zcodeLocalInstall.js";

const HOST = { platform: "win32", home: "C:\\Users\\tester", username: "tester" };

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encrypt(plaintext, key = zcodeCredentialKey(HOST)) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return `enc:v1:${b64url(nonce)}.${b64url(cipher.getAuthTag())}.${b64url(ct)}`;
}

function makeFixture({ config, credentials }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-v2-"));
  if (config) fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  if (credentials) fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(credentials));
  return dir;
}

afterEach(() => {
  delete process.env.ZCODE_CREDENTIAL_SECRET;
});

describe("zcodeCredentialKey / decryptZcodeValue", () => {
  it("derives the fallback key from platform/home/username", () => {
    const a = zcodeCredentialKey(HOST);
    const b = zcodeCredentialKey({ ...HOST, username: "other" });
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });

  it("roundtrips an enc:v1 blob and rejects foreign shapes", () => {
    const key = zcodeCredentialKey(HOST);
    const blob = encrypt("hello");
    expect(decryptZcodeValue(blob, key)).toBe("hello");
    expect(decryptZcodeValue("plain", key)).toBeNull();
    expect(decryptZcodeValue("enc:v1:xx.yy", key)).toBeNull();
    expect(decryptZcodeValue(encrypt("x", crypto.randomBytes(32)), key)).toBeNull();
  });

  it("honors the ZCODE_CREDENTIAL_SECRET env override", () => {
    const envKey = zcodeCredentialKey({ envSecret: "custom-secret" });
    const blob = encrypt("payload", envKey);
    expect(decryptZcodeValue(blob, envKey)).toBe("payload");
  });
});

describe("readZcodeLocalInstall", () => {
  it("picks up a plaintext bigmodel key from config.json and ignores z.ai keys", async () => {
    const dir = makeFixture({
      config: {
        provider: {
          "builtin:bigmodel-coding-plan": { options: { apiKey: "id.secret" } },
          "builtin:zai-coding-plan": { options: { apiKey: "zai-plain-49-char-key" } },
        },
      },
    });
    const { candidates, notes } = await readZcodeLocalInstall({ dir, ...HOST });
    expect(notes.some((n) => n.includes("credentials.json"))).toBe(true);
    expect(candidates).toEqual([
      { fullKey: "id.secret", userId: null, source: "config:builtin:bigmodel-coding-plan", kind: "bigmodel" },
    ]);
  });

  it("decrypts cached minted keys + user_info, offline", async () => {
    const key = zcodeCredentialKey(HOST);
    const dir = makeFixture({
      credentials: {
        "oauth:bigmodel:user_info": encrypt(JSON.stringify({ id: "uid-1", displayName: "T" }), key),
        "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:338:api-key": encrypt("id.secret", key),
        "web-remote-control:external-relay:pass_hash": encrypt("unrelated", key),
      },
    });
    const { candidates } = await readZcodeLocalInstall({ dir, ...HOST });
    expect(candidates).toEqual([
      { fullKey: "id.secret", userId: "uid-1", source: "credentials:account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:338:api-key", kind: "bigmodel" },
    ]);
  });

  it("falls back to the provider access_token when no key is cached", async () => {
    const key = zcodeCredentialKey(HOST);
    const dir = makeFixture({
      credentials: {
        "oauth:bigmodel:user_info": encrypt(JSON.stringify({ id: "uid-1" }), key),
        "oauth:bigmodel:access_token": encrypt("jwt.token.here", key),
      },
    });
    const { candidates } = await readZcodeLocalInstall({ dir, ...HOST });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].token).toBe("jwt.token.here");
    expect(candidates[0].userId).toBe("uid-1");
    expect(candidates[0].fullKey).toBeUndefined();
  });

  it("dedupes identical keys across sources", async () => {
    const key = zcodeCredentialKey(HOST);
    const dir = makeFixture({
      config: { provider: { "builtin:bigmodel": { options: { apiKey: "id.secret" } } } },
      credentials: {
        "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:1:api-key": encrypt("id.secret", key),
        "account-provider:coding-plan:account:bigmodel-team-coding-plan:account:2:api-key": encrypt("id.secret", key),
      },
    });
    const { candidates } = await readZcodeLocalInstall({ dir, ...HOST });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].fullKey).toBe("id.secret");
  });

  it("returns no candidates when the host context cannot decrypt", async () => {
    const dir = makeFixture({
      credentials: {
        "oauth:bigmodel:user_info": encrypt("{}", zcodeCredentialKey({ ...HOST, username: "someone-else" })),
        "oauth:bigmodel:access_token": encrypt("jwt", zcodeCredentialKey({ ...HOST, username: "someone-else" })),
      },
    });
    const { candidates, notes } = await readZcodeLocalInstall({ dir, ...HOST });
    expect(candidates).toEqual([]);
    expect(notes.some((n) => n.includes("not decryptable"))).toBe(true);
  });

  it("returns empty for a missing install", async () => {
    const { candidates, notes } = await readZcodeLocalInstall({ dir: path.join(os.tmpdir(), "zcode-nope-xyz"), ...HOST });
    expect(candidates).toEqual([]);
    expect(notes).toHaveLength(2);
  });
});
