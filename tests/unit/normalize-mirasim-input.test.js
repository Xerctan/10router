// zcode-plugin/scripts/normalize-mirasim-input.mjs must add the cache to
// prompt_tokens exactly once.
//
// It used to skip only rows flagged mirasimInputNormalized — but the fixed
// converters (plugin export-usage ≥ v1.5.0, CreditDaddy's usage sync) already
// write prompt = input + cache WITHOUT that flag, so running the script after a
// sync added the cache a second time (638 + 113M became 638 + 226M), in the rows
// and in the day buckets.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const SCRIPT = fileURLToPath(new URL("../../zcode-plugin/scripts/normalize-mirasim-input.mjs", import.meta.url));
const EXPORT = fileURLToPath(new URL("../../zcode-plugin/scripts/export-usage.mjs", import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-mirasim-norm-"));
const dbPath = path.join(tempDir, "data.sqlite");

const CACHE = 113_000_000;
const TS = "2026-09-20T10:00:00.000Z";
const PROVIDER = "mirasim-anthropic";
const MODEL = "claude-x";
const localDay = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function seed() {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, provider TEXT, model TEXT,
             connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER, tokens TEXT, meta TEXT);
           CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT);`);
  const ins = db.prepare(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, tokens, meta)
                          VALUES(?,?,?,?,?,?,?,?,?)`);
  const row = (endpoint, prompt, meta) => ins.run(TS, PROVIDER, MODEL, null, null, endpoint, prompt,
    JSON.stringify({ prompt_tokens: prompt, completion_tokens: 10, cache_read_input_tokens: CACHE }), JSON.stringify(meta));
  row("mirasim://old", 638, { source: "mirasim" });                                     // old converter: net-new only
  row("mirasim://creditdaddy", 638 + CACHE, { source: "mirasim" });                     // fixed converter, no flag
  row("mirasim://flagged", 638 + CACHE, { source: "mirasim", mirasimInputNormalized: true });
  const counters = (endpoint, prompt) => ({ promptTokens: prompt });
  db.prepare(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`).run(localDay(TS), JSON.stringify({
    promptTokens: 638 + 2 * (638 + CACHE),
    byProvider: { [PROVIDER]: counters(null, 638 + 2 * (638 + CACHE)) },
    byModel: { [`${MODEL}|${PROVIDER}`]: counters(null, 638 + 2 * (638 + CACHE)) },
    byApiKey: { [`local-no-key|${MODEL}|${PROVIDER}`]: counters(null, 638 + 2 * (638 + CACHE)) },
    byEndpoint: {
      [`mirasim://old|${MODEL}|${PROVIDER}`]: counters(null, 638),
      [`mirasim://creditdaddy|${MODEL}|${PROVIDER}`]: counters(null, 638 + CACHE),
      [`mirasim://flagged|${MODEL}|${PROVIDER}`]: counters(null, 638 + CACHE),
    },
  }));
  db.close();
}

const run = (...extra) => execFileSync(process.execPath, ["--no-warnings", SCRIPT, dbPath, ...extra], { encoding: "utf8" });
const read = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = Object.fromEntries(db.prepare(`SELECT endpoint, promptTokens, tokens FROM usageHistory`).all()
    .map((r) => [r.endpoint.replace("mirasim://", ""), { prompt: r.promptTokens, tokenPrompt: JSON.parse(r.tokens).prompt_tokens }]));
  const day = JSON.parse(db.prepare(`SELECT data FROM usageDaily`).get().data);
  db.close();
  return { rows, day };
};

beforeAll(seed);
afterAll(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* sqlite handle on Windows */ } });

describe("normalize-mirasim-input", () => {
  it("dry-run reports the unflagged new-convention row as already including cache", () => {
    const out = run();
    expect(out).toMatch(/rows to normalize : 1 /);
    expect(out).toMatch(/already flagged: 1, already include cache: 1/);
  });

  it("--apply adds the cache to the old row only — never twice", () => {
    run("--apply", "--quiet");
    const { rows, day } = read();
    expect(rows.old).toEqual({ prompt: 638 + CACHE, tokenPrompt: 638 + CACHE });
    expect(rows.creditdaddy.prompt).toBe(638 + CACHE);  // untouched (was: 638 + 2×CACHE)
    expect(rows.flagged.prompt).toBe(638 + CACHE);
    expect(day.promptTokens).toBe(3 * (638 + CACHE));   // exactly one CACHE added to the bucket
    expect(day.byEndpoint[`mirasim://creditdaddy|${MODEL}|${PROVIDER}`].promptTokens).toBe(638 + CACHE);
  });

  it("is idempotent", () => {
    expect(run()).toMatch(/nothing to do/);
  });

  it("the plugin's converter flags the rows it writes", () => {
    const src = fs.readFileSync(EXPORT, "utf8");
    const fn = src.slice(src.indexOf("function convertMirasimRow"), src.indexOf("function", src.indexOf("function convertMirasimRow") + 10));
    expect(fn).toContain("mirasimInputNormalized: true");
    expect(fn).toContain("(e.input || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0)");
  });
});
