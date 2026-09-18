// Qoder auto daily check-in (both Domestic/CN and International).
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
 * Checkin if not already done today.
 */
async function checkinIfNotDone(conn, deps) {
  const memo = deps.doneMap || (await getDoneMap());
  const today = dayKey(deps.nowMs);
  if (memo[conn.id] === today) {
    return {
      connectionId: conn.id,
      account: conn.name || conn.email || conn.id,
      provider: conn.provider,
      status: "already",
      memoized: true,
    };
  }

  const res = await checkinOneQoder(conn, deps);
  if (res.status === "checked-in" || res.status === "already") {
    memo[conn.id] = today;
  }
  return res;
}

/**
 * Execute a check-in run across all eligible Qoder / Qoder CN connections.
 */
export async function runQoderCheckinTick(deps = {}) {
  const { getProviderConnections } = await import("../../lib/localDb.js");
  const conns = await getProviderConnections();

  const eligible = conns.filter(isEligibleQoderConnection);
  if (eligible.length === 0) return [];

  const memo = deps.doneMap || (await getDoneMap());
  const checkinFn = deps.checkinConnection || (deps.skipIfCheckedToday ? checkinIfNotDone : checkinOneQoder);

  const results = [];
  for (const conn of eligible) {
    const outcome = await checkinFn(conn, { ...deps, doneMap: memo });
    results.push(outcome);

    if (outcome.status === "checked-in") {
      memo[conn.id] = dayKey(deps.nowMs);
      log.info("QODER_CHECKIN", `Successfully claimed Credits for ${outcome.account}`, {
        provider: outcome.provider,
        amount: outcome.claimedAmount,
      });
    } else if (outcome.status === "already") {
      memo[conn.id] = dayKey(deps.nowMs);
    }
  }

  await persistDoneMap();
  return results;
}

export function startQoderCheckin() {
  if (started) return;
  started = true;

  const scheduleNext = () => {
    const jitter = Math.floor(Math.random() * TICK_JITTER_MS);
    const delay = TICK_MS + jitter;
    timerHandle = setTimeout(async () => {
      try {
        const settings = await loadSettingsSafe();
        if (settings.qoderCheckin !== false) {
          await runQoderCheckinTick({ skipIfCheckedToday: true });
        }
      } catch (e) {
        log.warn("QODER_CHECKIN", "Tick failed", { error: e.message });
      } finally {
        if (started) scheduleNext();
      }
    }, delay);
    if (timerHandle && typeof timerHandle.unref === "function") {
      timerHandle.unref();
    }
  };

  // Run initial tick shortly after startup
  setTimeout(async () => {
    try {
      const settings = await loadSettingsSafe();
      if (settings.qoderCheckin !== false) {
        await runQoderCheckinTick({ skipIfCheckedToday: true });
      }
    } catch (e) {
      log.warn("QODER_CHECKIN", "Initial tick failed", { error: e.message });
    } finally {
      if (started) scheduleNext();
    }
  }, 15000);
}

export function stopQoderCheckin() {
  started = false;
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}
