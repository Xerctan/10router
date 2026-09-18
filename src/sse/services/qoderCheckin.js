// Qoder auto daily credit claim (both Domestic/CN and International).
//
// Automatically claims daily Credits (e.g. 100 Credits refreshed at 10:00 UTC+8,
// and other platform campaign benefits) for all active Qoder accounts without
// requiring the user to open the desktop app.
//
// Scheduler ticks every ~2h (+ jitter): an account is checked until today's claim
// is confirmed, then memoized in `qoderDailyDone` for the rest of the day.

import * as log from "../utils/logger.js";
import {
  QODER_OPENAPI_BASE,
  QODER_CN_OPENAPI_BASE,
} from "../../../open-sse/shared/qoder/constants.js";

const TICK_MS = 2 * 60 * 60 * 1000;
const TICK_JITTER_MS = 10 * 60 * 1000;

let started = false;
let timerHandle = null;
let doneMap = null;

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") {
    return true;
  }
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

export function msUntilNextTick(nowMs = Date.now(), rand = Math.random) {
  const jitter = Math.floor(rand() * TICK_JITTER_MS);
  return Math.max(TICK_MS + jitter, 1000);
}

async function loadSettingsSafe() {
  try {
    const { getSettings } = await import("../../lib/localDb.js");
    return (await getSettings()) || {};
  } catch {
    return {};
  }
}

async function getDoneMap() {
  if (doneMap) return doneMap;
  const settings = await loadSettingsSafe();
  const raw = settings?.qoderDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function persistDoneMap() {
  if (!doneMap) return;
  const today = dayKey();
  const pruned = {};
  for (const [id, day] of Object.entries(doneMap)) {
    if (day === today) pruned[id] = day;
  }
  try {
    const { updateSettings } = await import("../../lib/localDb.js");
    await updateSettings({ qoderDailyDone: pruned });
    for (const k of Object.keys(doneMap)) delete doneMap[k];
    Object.assign(doneMap, pruned);
  } catch (err) {
    log.warn("QODER_CHECKIN", "Persist daily-done map failed", {
      error: err?.message ?? String(err),
    });
  }
}

export function getQoderOpenApiBase(provider) {
  return provider === "qoder-cn" ? QODER_CN_OPENAPI_BASE : QODER_OPENAPI_BASE;
}

export function isEligibleQoderConnection(conn) {
  if (!conn || conn.isActive === false) return false;
  if (conn.provider !== "qoder" && conn.provider !== "qoder-cn") return false;
  const token = conn.accessToken || conn.apiKey;
  return typeof token === "string" && token.trim().length > 0;
}

export function buildQoderHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Cosy-ClientType": "10",
    "Cosy-Version": "0.3.3",
    "Cosy-MachineOS": process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    "User-Agent": "Qoder",
    Accept: "application/json",
  };
}

/**
 * Resolve effective token (exchange PAT to job token if needed).
 */
async function resolveToken(conn) {
  let token = conn.accessToken || conn.apiKey;
  if (typeof token !== "string") return null;
  token = token.trim();

  // If PAT (pt-...), exchange for short-lived job token
  if (token.startsWith("pt-")) {
    try {
      const { exchangePatToJobToken } = await import(
        "../../../open-sse/services/qoderModels.js"
      );
      const isCn = conn.provider === "qoder-cn";
      token = await exchangePatToJobToken(token, isCn);
    } catch (e) {
      log.warn("QODER_CHECKIN", "PAT exchange failed", { connectionId: conn.id, error: e.message });
      return null;
    }
  }
  return token;
}

/**
 * Claim campaigns for a single Qoder connection.
 */
export async function checkinOneQoder(conn, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const baseUrl = getQoderOpenApiBase(conn.provider);
  const token = await resolveToken(conn);

  if (!token) {
    return {
      connectionId: conn.id,
      account: conn.name || conn.email || conn.id,
      provider: conn.provider,
      status: "failed",
      error: "Token unavailable",
    };
  }

  const headers = buildQoderHeaders(token);
  const campaignsUrl = `${baseUrl}/sash/api/v1/me/campaigns?clientType=10`;

  try {
    const listRes = await fetchFn(campaignsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (listRes.status === 401 || listRes.status === 403) {
      return {
        connectionId: conn.id,
        account: conn.name || conn.email || conn.id,
        provider: conn.provider,
        status: "failed",
        error: `Authentication failed (${listRes.status})`,
      };
    }

    if (!listRes.ok) {
      return {
        connectionId: conn.id,
        account: conn.name || conn.email || conn.id,
        provider: conn.provider,
        status: "failed",
        error: `HTTP ${listRes.status}`,
      };
    }

    const payload = await listRes.json();
    const campaigns = Array.isArray(payload?.campaigns) ? payload.campaigns : [];

    const claimable = campaigns.filter(
      (c) => c.actionType === "CLAIM_BENEFIT" && c.claimStatus === "CLAIMABLE"
    );

    if (claimable.length === 0) {
      const alreadyCount = campaigns.filter((c) => c.claimStatus === "CLAIMED").length;
      return {
        connectionId: conn.id,
        account: conn.name || conn.email || conn.id,
        provider: conn.provider,
        status: "already",
        message: alreadyCount > 0 ? "今日已领或无待领活动" : "当前无活动权益",
        claimedAmount: 0,
      };
    }

    // Claim each available campaign
    let totalClaimed = 0;
    const claimedList = [];

    for (const c of claimable) {
      try {
        const claimUrl = `${baseUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(c.campaignId)}/claim`;
        const claimRes = await fetchFn(claimUrl, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(15000),
        });

        if (claimRes.ok) {
          const resJson = await claimRes.json().catch(() => ({}));
          const amount = resJson.benefit?.amount || c.benefit?.amount || 0;
          totalClaimed += amount;
          claimedList.push({
            campaignId: c.campaignId,
            campaignKey: c.campaignKey,
            amount,
            status: "claimed",
          });
        }
      } catch (err) {
        log.warn("QODER_CHECKIN", `Failed to claim campaign ${c.campaignId}`, { error: err.message });
      }
    }

    if (claimedList.length > 0) {
      return {
        connectionId: conn.id,
        account: conn.name || conn.email || conn.id,
        provider: conn.provider,
        status: "checked-in",
        claimedAmount: totalClaimed,
        campaigns: claimedList,
      };
    }

    return {
      connectionId: conn.id,
      account: conn.name || conn.email || conn.id,
      provider: conn.provider,
      status: "failed",
      error: "All claims failed",
    };
  } catch (err) {
    return {
      connectionId: conn.id,
      account: conn.name || conn.email || conn.id,
      provider: conn.provider,
      status: "failed",
      error: err.message || "Network error",
    };
  }
}

/**
 * Execute a check-in run across all eligible Qoder / Qoder CN connections.
 */
export async function runQoderCheckinTick(deps = {}) {
  const { getProviderConnections } = await import("../../lib/localDb.js");
  const conns = await getProviderConnections();

  const eligible = conns.filter(isEligibleQoderConnection);
  if (eligible.length === 0) {
    log.debug("QODER_CHECKIN", "Tick: no eligible Qoder connections");
    return [];
  }

  log.info("QODER_CHECKIN", "Daily credit-claim pass started", {
    eligible: eligible.length,
    ids: eligible.map((c) => c.id).filter(Boolean),
  });

  const memo = deps.doneMap || (await getDoneMap());
  const today = dayKey(deps.nowMs);
  const results = [];

  for (const conn of eligible) {
    try {
      if (deps.skipIfCheckedToday && memo[conn.id] === today) {
        log.debug("QODER_CHECKIN", `${conn.name || conn.id}: 今日已确认完成，跳过`, {
          id: conn.id,
        });
        results.push({
          connectionId: conn.id,
          account: conn.name || conn.email || conn.id,
          provider: conn.provider,
          status: "already",
          memoized: true,
        });
        continue;
      }

      const checkinFn = deps.checkinConnection || checkinOneQoder;
      const outcome = await checkinFn(conn, { ...deps, doneMap: memo });
      results.push(outcome);

      if (outcome.status === "checked-in") {
        memo[conn.id] = today;
        log.info("QODER_CHECKIN", `${conn.name || conn.id}: 领取成功 (+${outcome.claimedAmount} Credits)`, {
          id: conn.id,
          provider: outcome.provider,
          amount: outcome.claimedAmount,
        });
      } else if (outcome.status === "already") {
        memo[conn.id] = today;
        log.info("QODER_CHECKIN", `${conn.name || conn.id}: ${outcome.message || "今日已领或无待领活动"}`, {
          id: conn.id,
          provider: outcome.provider,
        });
      } else {
        log.warn("QODER_CHECKIN", `${conn.name || conn.id}: 领取失败 (${outcome.error || outcome.status})`, {
          id: conn.id,
          provider: outcome.provider,
        });
      }
    } catch (err) {
      results.push({
        connectionId: conn.id,
        account: conn.name || conn.id,
        provider: conn.provider,
        status: "failed",
        error: err?.message || String(err),
      });
      log.warn("QODER_CHECKIN", `${conn.name || conn.id}: 异常 (${err?.message || err})`, {
        id: conn.id,
      });
    }
  }

  await persistDoneMap();
  return results;
}

async function safeTick(how) {
  try {
    const settings = await loadSettingsSafe();
    if (settings.qoderCheckin !== true) {
      log.debug("QODER_CHECKIN", `Scheduled ${how}: setting off, skipping`);
      return;
    }
    const done = await getDoneMap();
    await runQoderCheckinTick({ skipIfCheckedToday: true, doneMap: done });
    await persistDoneMap();
  } catch (err) {
    log.warn("QODER_CHECKIN", `Scheduled ${how} rejected (swallowed)`, {
      error: err?.message ?? String(err),
    });
  }
}

function clearTimer() {
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}

function scheduleNext() {
  if (!started) return;
  const delayMs = msUntilNextTick();
  clearTimer();
  timerHandle = setTimeout(() => {
    safeTick("tick").finally(() => scheduleNext());
  }, delayMs);
  if (timerHandle && typeof timerHandle.unref === "function") {
    timerHandle.unref();
  }
  log.info("QODER_CHECKIN", "Next all-day credit-claim tick scheduled", {
    delaySec: Math.round(delayMs / 1000),
  });
}

/**
 * Start the scheduler. Runs an immediate boot pass then ticks every ~2h.
 * @param {{ skipBoot?: boolean }} [opts]
 * @returns {boolean} true if started this call
 */
export function startQoderCheckin(opts = {}) {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("QODER_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;

  if (opts.skipBoot !== true) {
    safeTick("boot");
  }
  scheduleNext();

  log.info("QODER_CHECKIN", "Scheduler started (all-day cadence)");
  return true;
}

export function stopQoderCheckin() {
  clearTimer();
  if (started) {
    started = false;
    log.info("QODER_CHECKIN", "Scheduler stopped");
  }
}
