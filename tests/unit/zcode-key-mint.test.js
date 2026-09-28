/**
 * ZCode credential helpers: token exchange, biz-API key minting, callback
 * parsing, import material normalization. All upstream calls run against a
 * stubbed global.fetch — no network, no real credentials.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildZcodeConnectionPayload,
  exchangeZcodeCode,
  findZcodeConnection,
  looksLikeBigmodelKey,
  mintBigmodelKey,
  mintZaiKey,
  parseZcodeCallback,
  pickZcodeImportMaterial,
} from "../../src/lib/oauth/providers/zcode.js";

// Fetch stub routing by URL (+ optional method) — first match wins, so order
// specific routes (copy) before generic ones (list).
function stubFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const r of routes) {
      if (r.method && (options.method || "GET") !== r.method) continue;
      if (url.includes(r.match)) {
        if (r.throw) throw new Error(r.throw);
        return { ok: r.status ? r.status < 400 : true, status: r.status || 200, text: async () => JSON.stringify(r.body ?? {}) };
      }
    }
    return { ok: false, status: 404, text: async () => "{}" };
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

const CUSTOMER_INFO = {
  data: {
    organizations: [
      {
        organizationName: "Other Org",
        organizationId: "org-2",
        projects: [],
      },
      {
        organizationName: "默认组织",
        organizationId: "org-1",
        projects: [{ projectName: "默认项目", projectId: "proj-1" }],
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mintBigmodelKey", () => {
  it("reuses the existing zcode-api-key and appends the secret", async () => {
    stubFetch([
      { match: "getCustomerInfo", body: CUSTOMER_INFO },
      { match: "/api_keys/copy/abc", body: { data: { secretKey: "shhh" } } },
      { match: "/api_keys", body: { data: [{ name: "other", apiKey: "x" }, { name: "zcode-api-key", apiKey: "abc" }] } },
    ]);
    const res = await mintBigmodelKey("tok-1");
    expect(res.fullKey).toBe("abc.shhh");
  });

  it("creates the key when none exists (find-or-create)", async () => {
    const { calls } = stubFetch([
      { match: "getCustomerInfo", body: CUSTOMER_INFO },
      { match: "/api_keys/copy/newkey", body: { data: { secretKey: "s2" } } },
      { match: "/api_keys", method: "POST", body: { data: { apiKey: "newkey" } } },
      { match: "/api_keys", body: { data: [] } },
    ]);
    const res = await mintBigmodelKey("tok-1");
    expect(res.fullKey).toBe("newkey.s2");
    const post = calls.find((c) => c.options.method === "POST");
    expect(post).toBeTruthy();
    expect(JSON.parse(post.options.body)).toEqual({ name: "zcode-api-key" });
    // Authorization carries the raw access token (no Bearer) on the bigmodel side.
    const info = calls.find((c) => c.url.includes("getCustomerInfo"));
    expect(info.options.headers.Authorization).toBe("tok-1");
  });

  it("degrades to the bare apiKey when the copy endpoint fails", async () => {
    stubFetch([
      { match: "getCustomerInfo", body: CUSTOMER_INFO },
      { match: "/api_keys/copy/abc", status: 500, body: { msg: "boom" } },
      { match: "/api_keys", body: { data: [{ name: "zcode-api-key", apiKey: "abc" }] } },
    ]);
    const res = await mintBigmodelKey("tok-1");
    expect(res.fullKey).toBe("abc");
  });

  it("picks the 默认组织/默认项目 entries, falling back to first", async () => {
    const { calls } = stubFetch([
      { match: "getCustomerInfo", body: CUSTOMER_INFO },
      { match: "/api_keys/copy/k", body: { data: {} } },
      { match: "/api_keys", method: "POST", body: { data: { apiKey: "k" } } },
      { match: "/api_keys", body: { data: [] } },
    ]);
    await mintBigmodelKey("tok-1");
    const list = calls.find((c) => c.url.includes("/api_keys"));
    expect(list.url).toContain("/organization/org-1/projects/proj-1/api_keys");
  });

  it("throws with the upstream message on biz failures", async () => {
    stubFetch([{ match: "getCustomerInfo", status: 401, body: { msg: "token expired" } }]);
    await expect(mintBigmodelKey("bad")).rejects.toThrow("token expired");
  });
});

describe("mintZaiKey", () => {
  it("logs in for a biz token then mints with Bearer auth", async () => {
    const { calls } = stubFetch([
      { match: "api/auth/z/login", body: { data: { access_token: "biz-1" } } },
      { match: "getCustomerInfo", body: CUSTOMER_INFO },
      { match: "/api_keys/copy/zk", body: { data: { secretKey: "zs" } } },
      { match: "/api_keys", body: { data: [{ name: "zcode-api-key", apiKey: "zk" }] } },
    ]);
    const res = await mintZaiKey("access-1");
    expect(res).toEqual({ apiKey: "zk", secret: "zs" });
    const info = calls.find((c) => c.url.includes("getCustomerInfo"));
    expect(info.options.headers.Authorization).toBe("Bearer biz-1");
  });

  it("fails when the login response has no access_token", async () => {
    stubFetch([{ match: "api/auth/z/login", body: { data: {} } }]);
    await expect(mintZaiKey("access-1")).rejects.toThrow("biz access_token");
  });
});

describe("exchangeZcodeCode", () => {
  it("exchanges and unwraps the bigmodel token + user", async () => {
    stubFetch([
      { match: "/oauth/token", body: { code: 0, data: { token: "jwt-1", bigmodel: { access_token: "at-1" }, user: { user_id: "u1" } } } },
    ]);
    const res = await exchangeZcodeCode({ code: "c1", redirectUri: "http://127.0.0.1:1/oauth/callback/bigmodel", state: "s1" });
    expect(res).toEqual({ providerToken: "at-1", jwt: "jwt-1", userId: "u1", provider: "bigmodel" });
  });

  it("surfaces upstream error codes and missing-token shapes", async () => {
    stubFetch([{ match: "/oauth/token", body: { code: 3001, msg: "parameter error" } }]);
    await expect(exchangeZcodeCode({ code: "c" })).rejects.toThrow("parameter error");
    stubFetch([{ match: "/oauth/token", body: { code: 0, data: {} } }]);
    await expect(exchangeZcodeCode({ code: "c" })).rejects.toThrow("no bigmodel access_token");
  });
});

describe("parseZcodeCallback", () => {
  it("parses the full redirect URL and a bare query string", () => {
    expect(parseZcodeCallback("http://127.0.0.1:9/oauth/callback/bigmodel?authCode=a1&state=s1")).toEqual({ authCode: "a1", state: "s1" });
    expect(parseZcodeCallback("authCode=a2&state=s2")).toEqual({ authCode: "a2", state: "s2" });
  });

  it("rejects empty input and URLs without an authCode", () => {
    expect(() => parseZcodeCallback("")).toThrow();
    expect(() => parseZcodeCallback("https://bigmodel.cn/whatever")).toThrow();
    expect(() => parseZcodeCallback("https://bigmodel.cn/x?foo=1")).toThrow("authCode");
  });
});

describe("looksLikeBigmodelKey / pickZcodeImportMaterial", () => {
  it("accepts two-segment keys only", () => {
    expect(looksLikeBigmodelKey("id.secret")).toBe(true);
    expect(looksLikeBigmodelKey("a.b.c")).toBe(false);
    expect(looksLikeBigmodelKey("plain")).toBe(false);
    expect(looksLikeBigmodelKey("")).toBe(false);
  });

  it("plain transfer accounts pass through; marker accounts read meta.credentials", () => {
    expect(pickZcodeImportMaterial({ accessToken: "id.secret" })).toEqual({ token: "id.secret", provider: null, uid: null });
    const cd = {
      accessToken: "zcode-creds:u1",
      meta: { credentials: { bigmodel: { access_token: "at-1" }, userId: "u1" } },
    };
    expect(pickZcodeImportMaterial(cd)).toEqual({ token: "at-1", provider: "bigmodel", uid: "u1" });
    const cdArray = {
      accessToken: "zcode-creds:u1",
      credentials: [{ zai: { access_token: "zat" } }, { bigmodel: { access_token: "bat" } }],
    };
    expect(pickZcodeImportMaterial(cdArray).token).toBe("bat");
  });

  it("flags zai-side material so the route can reject it explicitly", () => {
    const m = pickZcodeImportMaterial({ accessToken: "zcode-creds:u1", meta: { credentials: { zai: { access_token: "z1" } } } });
    expect(m.provider).toBe("zai");
  });

  it("returns null when nothing usable is present", () => {
    expect(pickZcodeImportMaterial({ accessToken: "zcode-creds:u1" })).toBeNull();
    expect(pickZcodeImportMaterial({})).toBeNull();
  });
});

describe("connection payload + dedupe matcher", () => {
  it("builds the api_key row with the zcode identity fields", () => {
    const p = buildZcodeConnectionPayload({ fullKey: "id.secret", userId: "u9", authMethod: "oauth" });
    expect(p.provider).toBe("zcode");
    expect(p.authType).toBe("apikey");
    expect(p.apiKey).toBe("id.secret");
    expect(p.accessToken).toBe("id.secret");
    expect(p.email).toBe("u9@zcode");
    expect(p.providerSpecificData).toMatchObject({ zcodeUserId: "u9", zcodeProvider: "bigmodel", authMethod: "oauth" });
    expect(JSON.stringify(p)).not.toContain("refresh_token");
  });

  it("matches by key first, then by zcodeUserId", () => {
    const rows = [
      { id: "a", apiKey: "k1", providerSpecificData: { zcodeUserId: "u1" } },
      { id: "b", apiKey: "k2", providerSpecificData: { zcodeUserId: "u2" } },
    ];
    expect(findZcodeConnection(rows, { key: "k2" }).id).toBe("b");
    expect(findZcodeConnection(rows, { userId: "u1" }).id).toBe("a");
    expect(findZcodeConnection(rows, { userId: "zz" })).toBeNull();
  });
});
