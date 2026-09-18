import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Redirect the Desktop profile into a sandbox. `vi.hoisted` runs before the module
// factory, so the path must be built without importing node:os. Only `homedir` is
// overridden — `tmpdir` stays real, because the test runner puts its own scratch
// files there and sandboxing it makes cleanup fail with EPERM.
const { FAKE } = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TEMP || "/tmp";
  return { FAKE: { home: `${base}/10r-mimo-test-home`.replace(/\\/g, "/") } };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, homedir: () => FAKE.home },
  };
});

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
  default: (...args) => fetchMock(...args),
}));

import { readDesktopPassToken, getMimoAccountUsage, getMimoAccountCookie, getMimoAccountBalance, invalidateMimoAccountCookieCache, desktopCookiePath } from "../../open-sse/shared/mimoAccount.js";
import { getXiaomiMimoUsage } from "../../open-sse/services/usage/xiaomi-mimo.js";

// The module owns the on-disk layout now (including APPDATA/XDG overrides), so the
// platform branches are asserted independently in xiaomi-mimo-paths.test.js and
// this file consumes the real helper instead of duplicating the derivation.
//
// The sandbox assertion is part of the accessor on purpose: these cases WRITE
// fixtures, and a mis-pinned env once put a fixture on a real Desktop profile.
function cookieDbPath() {
  const file = desktopCookiePath();
  assertSandboxed(file);
  return file;
}

let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}

/**
 * Fixtures must never land outside the sandbox. The cookie path is derived from
 * APPDATA/XDG_*, and a wrong env pin once wrote a fixture over a real Desktop
 * profile — so refuse loudly instead of trusting the caller.
 *
 * Compared on resolved paths: FAKE.home is built with forward slashes while the
 * module returns path.join() separators (backslashes on Windows).
 */
function assertSandboxed(file) {
  const root = path.resolve(FAKE.home);
  const resolved = path.resolve(file);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to touch a file outside the sandbox: ${file}`);
  }
}

async function writeCookieDb(file, rows) {
  assertSandboxed(file);
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT)");
  const insert = db.prepare("INSERT INTO cookies (name, value, host_key) VALUES (?, ?, ?)");
  for (const [name, value, host] of rows) insert.run(name, value, host);
  db.close();
}

const ENV_KEYS = ["APPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
const savedEnv = {};
const SANDBOX_APPDATA = `${FAKE.home}/AppData/Roaming`;
const SANDBOX_XDG_CONFIG = `${FAKE.home}/.config`;

beforeEach(() => {
  // The module resolves its paths from APPDATA / XDG_* (redirected Windows
  // profiles, XDG layouts), so the sandbox must PIN them — not merely hope they
  // are unset. Without this the win32 branch escapes FAKE.home and a fixture
  // write lands on the developer's REAL Desktop profile.
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.APPDATA = SANDBOX_APPDATA;
  process.env.XDG_CONFIG_HOME = SANDBOX_XDG_CONFIG;
  delete process.env.XDG_DATA_HOME;
  fetchMock.mockReset();
  fs.rmSync(FAKE.home, { recursive: true, force: true });
  invalidateMimoAccountCookieCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(FAKE.home, { recursive: true, force: true });
});

describe.skipIf(!hasSqlite)("xiaomi-mimo Desktop cookie store", () => {
  it("returns null when MiMo Desktop is not installed", async () => {
    expect(await readDesktopPassToken()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads passToken + identity from Desktop's cookie db", async () => {
    await writeCookieDb(cookieDbPath(), [
      ["passToken", "pt-secret", ".account.xiaomi.com"],
      ["userId", "12345", ".account.xiaomi.com"],
      ["cUserId", "c-678", ".account.xiaomi.com"],
      ["unrelated", "x", ".other.example"],
    ]);

    expect(await readDesktopPassToken()).toEqual({
      passToken: "pt-secret",
      userId: "12345",
      cUserId: "c-678",
    });
  });

  it("returns null when the cookie db has no passToken", async () => {
    await writeCookieDb(cookieDbPath(), [["userId", "12345", ".account.xiaomi.com"]]);
    expect(await readDesktopPassToken()).toBeNull();
  });

  it("degrades gracefully when the cookie db is unreadable", async () => {
    const file = cookieDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not a sqlite database");
    expect(await readDesktopPassToken()).toBeNull();
  });

  it("never leaves the copied cookie db behind", async () => {
    await writeCookieDb(cookieDbPath(), [["passToken", "pt-secret", ".account.xiaomi.com"]]);

    await readDesktopPassToken();

    // The copy is pid-scoped, so any match is this test's own leftover.
    const leftovers = fs
      .readdirSync(os.tmpdir())
      .filter((f) => f.startsWith(`10router-mimo-cookies-${process.pid}-`));
    expect(leftovers).toEqual([]);
  });

  it("reports a running Desktop as DESKTOP_LOCKED instead of a silent null", async () => {
    // Verified against the installed Windows client: while Xiaomi MiMo Desktop
    // runs, its cookie db is locked *exclusively* — even a plain readFileSync
    // fails with EBUSY, so this cannot be read around.
    await writeCookieDb(cookieDbPath(), [["passToken", "pt-secret", ".account.xiaomi.com"]]);
    const busy = new Error("EBUSY: resource busy or locked");
    busy.code = "EBUSY";
    const spy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
      throw busy;
    });

    await expect(readDesktopPassToken()).rejects.toMatchObject({ code: "DESKTOP_LOCKED" });

    // Usage paths must degrade rather than throw.
    await expect(getMimoAccountUsage()).resolves.toEqual({ error: "no-session" });
    await expect(getMimoAccountCookie()).resolves.toBeNull();
    spy.mockRestore();
  });

  it("treats a non-lock read failure as an absent session, not a lock", async () => {
    await writeCookieDb(cookieDbPath(), [["passToken", "pt-secret", ".account.xiaomi.com"]]);
    const gone = new Error("ENOENT");
    gone.code = "ENOENT";
    const spy = vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => {
      throw gone;
    });
    expect(await readDesktopPassToken()).toBeNull();
    spy.mockRestore();
  });
});

describe("xiaomi-mimo account session degradation", () => {
  it("reports no-session without touching the network", async () => {
    expect(await getMimoAccountUsage()).toEqual({ error: "no-session" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a null cookie instead of throwing", async () => {
    expect(await getMimoAccountCookie()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalidateMimoAccountCookieCache is safe to call", () => {
    expect(() => invalidateMimoAccountCookieCache()).not.toThrow();
  });
});

describe("xiaomi-mimo usage adapter", () => {
  it("asks for credentials when there is no session and no key", async () => {
    const out = await getXiaomiMimoUsage(null, null, null);
    expect(out.message).toMatch(/not connected/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains that a bare API key cannot read the quota", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => null });

    const out = await getXiaomiMimoUsage("sk-x", null, null);

    expect(out.plan).toBe("Xiaomi MiMo Desktop");
    expect(out.message).toMatch(/account session/i);
  });

  it("maps percent (remaining) into a weekly quota", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { percent: 94, resetDate: "2026-09-16" } }),
    });

    const out = await getXiaomiMimoUsage("sk-x", null, null);

    expect(out.plan).toBe("Xiaomi MiMo Desktop");
    expect(out.quotas.Weekly.used).toBe(6);
    expect(out.quotas.Weekly.remainingPercentage).toBe(94);
    expect(out.quotas.Weekly.unlimited).toBe(false);
    expect(out.quotas.Weekly.resetAt).toBe("2026-09-16T00:00:00.000Z");
  });

  it("prefers the epoch resetAt from the account service", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { percent: 50, resetAt: 1790000000 } }),
    });

    const out = await getXiaomiMimoUsage("sk-x", null, null);
    expect(out.quotas.Weekly.resetAt).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it("rejects a payload without a numeric percent", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 0, data: {} }) });

    const out = await getXiaomiMimoUsage("sk-x", null, null);
    expect(out.message).toMatch(/percent/i);
  });

  it("surfaces transport failures as a message, never a throw", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));

    const out = await getXiaomiMimoUsage("sk-x", null, null);
    expect(out.message).toContain("socket hang up");
  });
});

// ─── Platform console balance (api-platform session) ─────────────────────────
describe("xiaomi-mimo platform balance", () => {
  const P = "https://platform.xiaomimimo.com/api/v1/balance";
  const STS = "https://platform.xiaomimimo.com/sts?sign=abc&followup=" + encodeURIComponent(P);
  const LOGIN = "https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&_group=DEFAULT&callback=" + encodeURIComponent(STS);
  const BALANCE_BODY = {
    code: 0,
    message: "",
    data: { balance: "163.61", frozenBalance: "0.00", currency: "CNY", giftBalance: "163.61", cashBalance: "0.00" },
  };

  const res = (status, { location = null, setCookies = [], json = null, ok } = {}) => ({
    ok: ok ?? (status >= 200 && status < 300),
    status,
    headers: { get: (k) => (String(k).toLowerCase() === "location" ? location : null), getSetCookie: () => setCookies },
    json: async () => json,
    text: async () => (json ? JSON.stringify(json) : ""),
  });

  // Routes the whole api-platform chain; mimo-server (weekly) is failed fast so
  // balance-only flows can be asserted without a second SSO mock.
  function mockPlatformChain() {
    fetchMock.mockImplementation(async (url, opts = {}) => {
      const u = String(url);
      const ck = (opts.headers && opts.headers.Cookie) || "";
      if (u.startsWith("https://mimo-server")) return res(500, {});
      if (u === P || u.startsWith(P + "?")) {
        return ck.includes("api-platform_serviceToken")
          ? res(200, { json: BALANCE_BODY })
          : res(401, { json: { code: 401, loginUrl: LOGIN } });
      }
      if (u.startsWith("https://account.xiaomi.com/pass/serviceLogin")) {
        return res(302, {
          location: STS,
          setCookies: [
            "api-platform_serviceToken=sess-1; Domain=.xiaomimimo.com; Path=/; HttpOnly",
            "api-platform_ph=ph-1; Domain=.xiaomimimo.com; Path=/",
            "api-platform_slh=slh-1; Domain=.xiaomimimo.com; Path=/",
            "userId=6786673; Domain=.xiaomimimo.com; Path=/",
          ],
        });
      }
      if (u.startsWith("https://platform.xiaomimimo.com/sts")) {
        return res(307, { location: P + "?userId=6786673" });
      }
      throw new Error("unrouted fetch: " + u);
    });
  }

  it("degrades without a passToken and touches no network", async () => {
    expect(await getMimoAccountBalance(null, null)).toEqual({ error: "no-session" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges the passport jar for an api-platform session and reads the balance", async () => {
    mockPlatformChain();
    const out = await getMimoAccountBalance({ mimoPassToken: "pt-secret", mimoUserId: "6786673", mimoCUserId: "c-9" }, null);
    expect(out).toEqual({ balance: 163.61, gift: 163.61, cash: 0, frozen: 0, currency: "CNY" });
  });

  it("sends only platform-scoped cookies to the balance call — never the passToken", async () => {
    mockPlatformChain();
    await getMimoAccountBalance({ mimoPassToken: "pt-secret", mimoUserId: "6786673", mimoCUserId: "c-9" }, null);
    const calls = fetchMock.mock.calls.filter(([u, o]) => String(u).startsWith(P) && (o?.headers?.Cookie || "").includes("api-platform_serviceToken"));
    expect(calls.length).toBeGreaterThan(0);
    for (const [, o] of calls) expect(o.headers.Cookie).not.toMatch(/passToken/);
  });

  it("reuses the cached platform session without re-walking the chain", async () => {
    mockPlatformChain();
    const psd = { mimoPassToken: "pt-secret" };
    await getMimoAccountBalance(psd, null);
    const afterFirst = fetchMock.mock.calls.length;
    await getMimoAccountBalance(psd, null);
    expect(fetchMock.mock.calls.length).toBe(afterFirst + 1);
  });

  it("surfaces a Balance quota even when the weekly session fails", async () => {
    mockPlatformChain();
    const out = await getXiaomiMimoUsage(null, { mimoPassToken: "pt-secret" }, null);
    expect(out.plan).toBe("Xiaomi MiMo Desktop");
    expect(out.quotas["Balance (CNY)"]).toMatchObject({ used: 0, total: 163.61, remainingPercentage: 100 });
    expect(out.quotas.Weekly).toBeUndefined();
  });
});
