/**
 * Usage imports must carry an estimated cost.
 *
 * The zcode sync plugin exports per-request usage from a LOCAL ledger whose
 * `cost` column 10Router pricing never touched — so imported rows landed at $0
 * and the dashboard's estimated cost stayed empty. Three paths must price them:
 *
 *   1. fresh imports estimate on insert (same pricing table as live writes);
 *   2. re-imports repair rows that landed at $0 BEFORE the fix (dedup would
 *      otherwise skip them forever) — this is what the plugin's normal daily
 *      sync uses to heal recent history;
 *   3. boot sweep repairs zero-cost marked rows in place (covers the plugin's
 *      offline --import, which writes straight into the DB and runs through no
 *      import function at all).
 *
 * A source-computed cost must NEVER be overwritten, and rows that were not
 * imported (live gateway traffic) are out of scope.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-importcost-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;

const { initDb } = await import("@/lib/db/index.js");
const repo = await import("@/lib/db/repos/usageRepo.js");

const { importUsageRows, repairImportedUsageCosts } = repo;

let adapter;

beforeAll(async () => {
  await initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* open sqlite handle on Windows */ }
});

// Mirror getLocalDateKey (repo-private): the daily row lives under LOCAL date.
const dateKeyOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const historyRow = (ts) =>
  adapter.get(`SELECT cost FROM usageHistory WHERE timestamp = ?`, [ts]);
const dailyData = (ts) => {
  const r = adapter.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKeyOf(ts)]);
  return r ? JSON.parse(r.data) : null;
};

const MODEL = "glm-4.7"; // real MODEL_PRICING entry — cost must resolve > 0
const PROVIDER = "opencode-bigmodel"; // plugin-side provider spelling (no provider override)

const importRow = (ts, extra = {}) => ({
  timestamp: ts,
  provider: PROVIDER,
  model: MODEL,
  connectionId: null,
  apiKey: "sk-import-probe-123456",
  endpoint: null,
  promptTokens: 5_000_000,
  completionTokens: 1_000_000,
  tokens: { prompt_tokens: 5_000_000, completion_tokens: 1_000_000 },
  status: "ok",
  meta: {},
  ...extra,
});

describe("importUsageRows cost estimation", () => {
  it("prices rows that arrive without a cost", async () => {
    const ts = "2026-09-20T10:00:00.000Z";
    const res = await importUsageRows([importRow(ts)]);
    expect(res.imported).toBe(1);
    expect(historyRow(ts).cost).toBeGreaterThan(0);
    expect(dailyData(ts).cost).toBeGreaterThan(0);
  });

  it("keeps a source-computed cost untouched", async () => {
    const ts = "2026-09-20T11:00:00.000Z";
    await importUsageRows([importRow(ts, { cost: 5.5 })]);
    expect(historyRow(ts).cost).toBe(5.5);
  });

  it("re-import repairs a row that previously landed at zero cost (dedup-hit heal)", async () => {
    const ts = "2026-09-22T12:00:00.000Z"; // own local day — the other tests seed theirs
    // Simulate the pre-fix world: history at cost 0 with an imported stamp,
    // and a daily aggregate whose buckets carry cost 0.
    const row = importRow(ts);
    const { hashApiKey } = await import("@/lib/db/crypto/apiKeyIdentity.js");
    const legacyHash = hashApiKey("sk-import-probe-123456");
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyHash, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ts, PROVIDER, MODEL, null, "sk-impo***", legacyHash, null, 5_000_000, 1_000_000, 0, "ok",
        JSON.stringify(row.tokens), JSON.stringify({ imported: true })],
    );
    const bucket = { requests: 1, promptTokens: 5_000_000, completionTokens: 1_000_000, cachedTokens: 0, cost: 0 };
    adapter.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
      dateKeyOf(ts),
      JSON.stringify({
        requests: 1, promptTokens: 5_000_000, completionTokens: 1_000_000, cachedTokens: 0, cost: 0,
        byProvider: { [PROVIDER]: { ...bucket } },
        byModel: { [`${MODEL}|${PROVIDER}`]: { ...bucket } },
        byAccount: {},
        byApiKey: { [`${legacyHash}|${MODEL}|${PROVIDER}`]: { ...bucket } },
        byEndpoint: { [`Unknown|${MODEL}|${PROVIDER}`]: { ...bucket } },
      }),
    ]);

    // Same payload re-imported (what the plugin's next sync does).
    const res = await importUsageRows([importRow(ts)]);
    expect(res.imported).toBe(0); // dedup — no duplicate row
    expect(historyRow(ts).cost).toBeGreaterThan(0);

    const day = dailyData(ts);
    expect(day.cost).toBe(historyRow(ts).cost);
    expect(day.byProvider[PROVIDER].cost).toBe(day.cost);
    expect(day.byModel[`${MODEL}|${PROVIDER}`].cost).toBe(day.cost);
    expect(day.byApiKey[`${legacyHash}|${MODEL}|${PROVIDER}`].cost).toBe(day.cost);
    expect(day.byEndpoint[`Unknown|${MODEL}|${PROVIDER}`].cost).toBe(day.cost);
    // Delta-only patch: never fabricates counters.
    expect(day.requests).toBe(1);
  });
});

describe("boot sweep repairImportedUsageCosts", () => {
  it("prices a marked zero-cost row that never came through any import path", async () => {
    const ts = "2026-08-01T10:00:00.000Z"; // plugin's offline --import writes directly
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyHash, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ts, PROVIDER, MODEL, null, "sk-offl***", "hash-offline", null, 5_000_000, 1_000_000, 0, "ok",
        JSON.stringify({ prompt_tokens: 5_000_000, completion_tokens: 1_000_000 }),
        JSON.stringify({ gatewaySync: true })],
    );
    const r = await repairImportedUsageCosts();
    expect(r.repaired).toBeGreaterThanOrEqual(1);
    expect(historyRow(ts).cost).toBeGreaterThan(0);

    // Idempotent: repaired rows drop out of the scan.
    const again = await repairImportedUsageCosts();
    expect(again.repaired).toBe(0);
  });

  it("never touches unmarked (live) zero-cost rows", async () => {
    const ts = "2026-08-02T10:00:00.000Z";
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyHash, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ts, PROVIDER, MODEL, null, "sk-live***", "hash-live", null, 5_000_000, 1_000_000, 0, "ok",
        JSON.stringify({ prompt_tokens: 5_000_000, completion_tokens: 1_000_000 }),
        JSON.stringify({})],
    );
    await repairImportedUsageCosts();
    expect(historyRow(ts).cost).toBe(0);
  });
});

describe("boot wiring", () => {
  it("initializeApp runs the cost sweep on startup without letting it break boot", async () => {
    // Resolve from this file, not cwd: CI runs vitest from tests/, local runs may start at the root.
    const src = fs.readFileSync(
      new URL("../../src/shared/services/initializeApp.js", import.meta.url),
      "utf8",
    );
    expect(src).toContain("repairImportedUsageCosts()");
    expect(src).toMatch(/repairImportedUsageCosts\(\)[\s\S]{0,20}\.catch\(/);
  });
});
