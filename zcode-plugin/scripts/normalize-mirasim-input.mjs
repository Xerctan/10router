#!/usr/bin/env node
/**
 * normalize-mirasim-input.mjs — one-shot correction of imported mirasim rows
 * whose prompt_tokens excluded cache (the old converter reported mirasim's
 * `input` field verbatim, but mirasim logs input as NET-NEW only: cacheRead /
 * cacheWrite live in separate fields — verified anthropic sum(input)=110K vs
 * sum(cacheRead)=471M, openai-chat 16.5M vs 123M, openai-responses 5.8M vs
 * 145M). The converter now reports prompt = input + cacheRead + cacheWrite;
 * this script brings ALREADY-IMPORTED rows to the same convention so that a
 * re-sync dedups instead of duplicating (signature includes promptTokens).
 *
 * Which rows: provider LIKE 'mirasim-%' that are neither flagged nor already in
 * the new convention. Rows written by a fixed converter (this plugin's
 * export-usage ≥ v1.5.0, CreditDaddy's usage sync) already carry
 * prompt = input + cache, and CreditDaddy never sets the flag — so the flag
 * alone is not enough: adding the cache again would double-count it (a 638 +
 * 113M row would become 638 + 226M). The data itself tells them apart: a
 * new-convention row always has promptTokens >= cacheRead + cacheWrite. Such
 * rows are skipped. Price: an OLD row whose net-new input already exceeded its
 * cache is skipped too, undercounting it by at most its own input — against a
 * double count of the whole cache.
 *
 * What it changes per normalized row:
 *   - usageHistory.promptTokens  += cache_read + cache_creation
 *   - usageHistory.tokens.prompt_tokens = same new value
 *   - usageHistory.meta.mirasimInputNormalized = true   (idempotency flag)
 *
 * Then DELTA-PATCHES the touched usageDaily buckets (top-level promptTokens +
 * the byProvider/byModel/byApiKey/byEndpoint/byAccount counters those rows
 * contribute to). Deliberately NOT a full bucket rebuild: only promptTokens
 * moves, everything else stays byte-identical — no risk of re-keying
 * counters (the plugin mirror's byApiKey key format diverges from the server
 * for non-null keys; mirasim rows always carry apiKey=null, whose key format
 * is identical on both sides: `local-no-key|<model>|<provider>`).
 *
 * Cost/requests/cachedTokens/completionTokens and the lifetime counter are
 * untouched (no row added or removed).
 *
 * Usage:
 *   node normalize-mirasim-input.mjs /path/to/data.sqlite            # dry-run
 *   node normalize-mirasim-input.mjs /path/to/data.sqlite --apply    # write
 *
 * Back up the db (copy data.sqlite + -wal + -shm) before --apply, and run
 * verify-usage-db.mjs afterwards. WAL databases allow a short concurrent
 * write window, but a backup is still the rollback path.
 * Exit codes: 0 ok · 1 row/day problems (refuses to apply) · 2 bad args.
 */

import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const FLAG = "mirasimInputNormalized";

const args = { dbPath: null, apply: false, quiet: false };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node normalize-mirasim-input.mjs <data.sqlite> [--apply] [--quiet]

Dry-run by default; --apply writes. Back up the db first, verify after.`);
      process.exit(0);
    } else if (!args.dbPath && !a.startsWith("-")) args.dbPath = a;
    else { console.error(`error: unknown argument ${a}`); process.exit(2); }
  }
}
if (!args.dbPath) { console.error("error: missing <data.sqlite>"); process.exit(2); }
const log = (...m) => { if (!args.quiet) console.log(...m); };

// ── helpers (mirror server usageRepo.aggregateEntryToDay key formulas) ──────

function hashApiKey(key) {
  if (!key || typeof key !== "string") return null;
  return crypto.createHash("sha256").update(key).digest("hex");
}

function localDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

// The day-bucket counters one row contributes a promptTokens delta to.
// Mirrors src/lib/db/repos/usageRepo.js aggregateEntryToDay exactly.
function counterKeys(row) {
  const model = row.model || "unknown";
  const provider = row.provider || "unknown";
  const out = [];
  if (row.provider) out.push(["byProvider", row.provider]);
  out.push(["byModel", row.provider ? `${model}|${row.provider}` : model]);
  if (row.connectionId) out.push(["byAccount", row.connectionId]);
  out.push(["byApiKey", `${hashApiKey(row.apiKey) || "local-no-key"}|${model}|${provider}`]);
  out.push(["byEndpoint", `${row.endpoint || "Unknown"}|${model}|${provider}`]);
  return out;
}

// ── load & plan ─────────────────────────────────────────────────────────────

const db = new DatabaseSync(args.dbPath, args.apply ? {} : { readOnly: true });
if (args.apply) db.exec("PRAGMA busy_timeout = 10000");

let rows;
try {
  rows = db.prepare(
    `SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, tokens, meta
     FROM usageHistory WHERE provider LIKE 'mirasim-%' ORDER BY id`
  ).all();
} catch (e) {
  console.error(`error: cannot read usageHistory: ${e.message}`);
  process.exit(1);
}

const pending = [];
let alreadyFlagged = 0;
let alreadyIncluded = 0;
for (const r of rows) {
  const meta = parseJson(r.meta);
  if (meta[FLAG]) { alreadyFlagged++; continue; }
  const t = parseJson(r.tokens);
  const delta = (t.cache_read_input_tokens || 0) + (t.cache_creation_input_tokens || 0);
  // Already prompt = input + cache (fixed converter, no flag) — see header.
  if (delta > 0 && (r.promptTokens || 0) >= delta) { alreadyIncluded++; continue; }
  const newPrompt = (r.promptTokens || 0) + delta;
  pending.push({
    row: r,
    delta,
    newPrompt,
    newTokens: { ...t, prompt_tokens: newPrompt },
    newMeta: { ...meta, [FLAG]: true },
  });
}

if (pending.length === 0) {
  log(`nothing to do (${rows.length} mirasim rows: ${alreadyFlagged} flagged, ${alreadyIncluded} already include cache)`);
  db.close();
  process.exit(0);
}

// Group deltas per touched local day + counter. Separator \x00 cannot appear
// in provider/model/endpoint values, unlike '|' which they can.
const dayDeltas = new Map(); // dayKey -> { prompt, counters: Map<`dim\x00key`, delta> }
let totalDelta = 0;
for (const p of pending) {
  totalDelta += p.delta;
  const dayKey = localDateKey(p.row.timestamp);
  let d = dayDeltas.get(dayKey);
  if (!d) { d = { prompt: 0, counters: new Map() }; dayDeltas.set(dayKey, d); }
  d.prompt += p.delta;
  if (p.delta === 0) continue; // zero-delta rows only need the flag
  for (const [dim, key] of counterKeys(p.row)) {
    const ck = `${dim}\x00${key}`;
    d.counters.set(ck, (d.counters.get(ck) || 0) + p.delta);
  }
}

// Preflight: every touched day must have a bucket, else refuse (apply would
// leave fidelity broken with nothing to patch into).
const missingDays = [];
for (const dayKey of dayDeltas.keys()) {
  const exists = db.prepare(`SELECT 1 FROM usageDaily WHERE dateKey = ?`).get(dayKey);
  if (!exists) missingDays.push(dayKey);
}
if (missingDays.length > 0) {
  console.error(`error: no usageDaily bucket for ${missingDays.length} touched day(s): ${missingDays.slice(0, 10).join(", ")}`);
  console.error("refusing to apply — investigate first (verify-usage-db.mjs shows day fidelity).");
  db.close();
  process.exit(1);
}

log(`mirasim input normalization ${args.apply ? "APPLY" : "dry-run"} on ${args.dbPath}`);
log(`  rows to normalize : ${pending.length}  (already flagged: ${alreadyFlagged}, already include cache: ${alreadyIncluded}, total mirasim rows: ${rows.length})`);
log(`  promptTokens delta: ${totalDelta.toLocaleString("en-US")}`);
log(`  days touched      : ${dayDeltas.size}`);
for (const p of pending.slice(0, 3)) {
  log(`  sample: id=${p.row.id} ${p.row.promptTokens} -> ${p.newPrompt} (+${p.delta})`);
}

if (!args.apply) {
  log("dry-run only — re-run with --apply to write (back up the db first)");
  db.close();
  process.exit(0);
}

// ── apply (single transaction) ──────────────────────────────────────────────

const upd = db.prepare(`UPDATE usageHistory SET promptTokens = ?, tokens = ?, meta = ? WHERE id = ?`);
const getDay = db.prepare(`SELECT data FROM usageDaily WHERE dateKey = ?`);
const putDay = db.prepare(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`);

let patchedCounters = 0;
const missingCounters = [];
db.exec("BEGIN");
try {
  for (const p of pending) {
    upd.run(p.newPrompt, JSON.stringify(p.newTokens), JSON.stringify(p.newMeta), p.row.id);
  }
  for (const [dayKey, d] of dayDeltas) {
    if (d.prompt === 0 && d.counters.size === 0) continue; // flag-only day
    const row = getDay.get(dayKey);
    const data = parseJson(row.data);
    data.promptTokens = (data.promptTokens || 0) + d.prompt;
    for (const [ck, delta] of d.counters) {
      const sep = ck.indexOf("\x00");
      const dim = ck.slice(0, sep);
      const key = ck.slice(sep + 1);
      const counter = data[dim] && data[dim][key];
      if (counter) { counter.promptTokens = (counter.promptTokens || 0) + delta; patchedCounters++; }
      else missingCounters.push(`${dayKey} ${dim}[${key}]`);
    }
    putDay.run(dayKey, JSON.stringify(data));
  }
  if (missingCounters.length > 0) {
    throw new Error(`${missingCounters.length} counter key(s) missing in day buckets (first: ${missingCounters[0]})`);
  }
  db.exec("COMMIT");
} catch (e) {
  try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
  console.error(`error: ${e.message} — rolled back, nothing written`);
  db.close();
  process.exit(1);
}

db.close();
log(`applied: ${pending.length} rows normalized, ${dayDeltas.size} day buckets patched (${patchedCounters} counters)`);
log(`next: node verify-usage-db.mjs ${path.resolve(args.dbPath)}   # expect PASS`);
log(`note: historical rows now match the converter's new convention — a re-sync`);
log(`      must show only genuinely-new rows as imported, all old ones skipped.`);
