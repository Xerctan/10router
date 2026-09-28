/**
 * ZCode import landing path (real sqlite via temp DATA_DIR) + registry shape
 * lock. The registry lock pins the hard boundary: the zcode provider faces the
 * STANDARD bigmodel endpoints only — never the captcha-gated zcode.z.ai plan
 * endpoints (3007 territory, intentionally out of scope).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildZcodeConnectionPayload, findZcodeConnection } from "../../src/lib/oauth/providers/zcode.js";

describe("zcode importAccounts landing", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let mod;
  let models;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `zcode-import-test-${Date.now()}`);
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    // db module caches DATA_DIR at import time — set env first (oauth-transfer convention).
    const db = await import("@/lib/db/index.js");
    await db.initDb();
    mod = await import("../../src/lib/oauth/accountTransfer.js");
    models = await import("@/models");
  });

  afterAll(async () => {
    process.env.DATA_DIR = originalDataDir;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const keyOf = (uid) => `id-${uid}.secret-${uid}`;

  it("creates a connection from a minted-key import, then updates on re-import", async () => {
    const payload = {
      accessToken: keyOf("u1"),
      authType: "apikey",
      name: "ZCode u1",
      email: "u1@zcode",
      providerSpecificData: { zcodeUserId: "u1", zcodeProvider: "bigmodel", authMethod: "creditdaddy-import" },
    };
    const first = await mod.importAccounts("zcode", [payload]);
    expect(first.imported).toBe(1);
    expect(first.failed).toBe(0);

    // Same file re-imported: dedupe by apiKey, no stacking.
    const second = await mod.importAccounts("zcode", [{ ...payload, name: "Renamed" }]);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);

    // A different account (different key + uid) creates its own row.
    const third = await mod.importAccounts("zcode", [{
      ...buildZcodeConnectionPayload({ fullKey: keyOf("u2"), userId: "u2", authMethod: "creditdaddy-import" }),
    }]);
    expect(third.imported).toBe(1);

    const rows = (await models.getProviderConnections({ provider: "zcode" })).filter((c) => c.apiKey?.startsWith("id-"));
    expect(rows).toHaveLength(2);
    const conn = rows.find((r) => r.providerSpecificData?.zcodeUserId === "u1");
    expect(conn.apiKey).toBe(keyOf("u1"));
    expect(conn.apiKey).toBe(conn.accessToken);
    expect(conn.name).toBe("Renamed");
    expect(findZcodeConnection(rows, { userId: "u2" }).apiKey).toBe(keyOf("u2"));
  });
});

describe("zcode registry shape lock", () => {
  it("registers with dual auth and standard bigmodel endpoints only", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((r) => r.id === "zcode");
    expect(entry).toBeTruthy();
    expect(entry.category).toBe("oauth");
    expect(entry.authModes).toEqual(["oauth", "apikey"]);
    expect(entry.hasOAuth).toBe(true);
    expect(entry.alias).toBe("zcode");

    // 3007 red line: nothing in the registry entry may face the plan endpoints.
    const surfaces = JSON.stringify({ transport: entry.transport, transports: entry.transports, usage: entry.usage });
    expect(surfaces).not.toContain("zcode.z.ai");
    expect(surfaces).toContain("open.bigmodel.cn");

    // Coding-plan catalog (zcode-api 3.11.2 parity).
    expect(entry.models.map((m) => m.id)).toEqual([
      "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo",
      "glm-5-turbo", "glm-5", "glm-4.7", "glm-4.6", "glm-4.6v", "glm-4.5-air",
    ]);

    // Dual transports: openai chat + claude messages, both standard endpoints.
    const formats = entry.transports.map((t) => t.format).sort();
    expect(formats).toEqual(["claude", "openai"]);
    expect(entry.transport.usage.url).toContain("open.bigmodel.cn");
  });

  it("is wired into the generated registry index", async () => {
    const { PROVIDER_MODELS } = await import("../../open-sse/providers/index.js");
    expect(PROVIDER_MODELS["zcode"]?.length).toBe(11);
    expect(PROVIDER_MODELS["zcode"]?.[0]).toMatchObject({ id: "glm-5.3", name: "GLM 5.3" });
  });
});
