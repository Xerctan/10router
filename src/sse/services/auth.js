import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil, channelBlockRemainingMs } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { extractEarliestPackageExpiry } from "open-sse/services/usage/expiryExtractor.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

// In-flight tracking for non-blocking background quota refresh
const _quotaRefreshInFlight = new Set();

/**
 * Background quota refresh for the earliest-expiry strategy.
 *
 * Callers skip this entirely while a channel-level breaker is active: the breaker
 * exists because the whole channel is being rejected (e.g. CodeBuddy 11128), so
 * any extra upstream call — even to the billing endpoint — works against letting
 * it clear, and the resulting timestamps would be unusable anyway. The breaker is
 * cleared by a successful chat request, so refresh resumes on its own.
 */
function triggerBackgroundQuotaRefresh(connections) {
  const STALE_MS = 15 * 60 * 1000;
  const now = Date.now();

  for (const conn of connections) {
    if (!conn.id || _quotaRefreshInFlight.has(conn.id)) continue;
    const checkedAt = conn.quotaCheckedAt ? new Date(conn.quotaCheckedAt).getTime() : 0;
    if (now - checkedAt < STALE_MS) continue;

    _quotaRefreshInFlight.add(conn.id);
    (async () => {
      try {
        const proxyConfig = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
        const proxyOptions = {
          connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
          connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
          connectionNoProxy: proxyConfig.connectionNoProxy || "",
          vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
        };
        const usage = await getUsageForProvider(conn, proxyOptions);
        const expiryInfo = extractEarliestPackageExpiry(usage);
        await updateProviderConnection(conn.id, {
          earliestPackageExpiry: expiryInfo?.expiry || null,
          earliestPackageName: expiryInfo?.name || null,
          quotaCheckedAt: new Date().toISOString(),
        });
      } catch {
        // Non-blocking, ignore background errors
      } finally {
        _quotaRefreshInFlight.delete(conn.id);
      }
    })();
  }
}

/**
 * Invalidate cached package-expiry timestamps so the next account selection
 * refetches them. Called when a channel breaker lifts: the window it covered may
 * have crossed a package boundary, and the earliest-expiry ordering would
 * otherwise rank accounts on stale data (the SWR path only refreshes after
 * STALE_MS, which the breaker could easily have exceeded without noticing).
 *
 * Best-effort: failures are swallowed, the next natural refresh still applies.
 */
export async function invalidateQuotaCache(provider) {
  try {
    const connections = await getProviderConnections({ provider });
    for (const conn of connections) {
      if (!conn?.id) continue;
      await updateProviderConnection(conn.id, { quotaCheckedAt: null });
    }
  } catch {
    // best-effort — never let cache invalidation break a successful request
  }
}


const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    // zcode-free: CreditDaddy 网关在本机回环免密，但局域网主机要求虚拟 key ——
    // 用户建了带 key 的连接时优先走真实连接，无连接才落 noAuth 虚拟行
    const hasZcodeConnection = providerId === "zcode-free"
      ? (await getProviderConnections({ provider: providerId, isActive: true })).length > 0
      : false;
    if (FREE_PROVIDERS[providerId]?.noAuth && !hasZcodeConnection) {
      const settings = await getSettings();
      // zcode-free: CreditDaddy 主机可配置（本机 127.0.0.1 或局域网 IP），
      // 覆盖注册表 baseUrl 的主机部分；端口固定跟 CreditDaddy daemon（47860 起）
      const cdHost = (settings.zcodeGatewayHost || '').trim();
      const virtualPsd = {};
      if (providerId === 'zcode-free') {
        try {
          // 路径可选：留空 = CreditDaddy 网关（/gateway/v1/messages）；
          // 直连 zcode-api 时填 /v1/messages（其端点路径与网关别名同形）
          const gwPath = (settings.zcodeGatewayPath || '').trim() || '/gateway/v1/messages';
          const u = new URL(`http://127.0.0.1:47860${gwPath.startsWith('/') ? '' : '/'}${gwPath}`);
          u.hostname = cdHost || '127.0.0.1';
          const port = Number((settings.zcodeGatewayPort || '').trim());
          if (Number.isInteger(port) && port > 0 && port < 65536) u.port = String(port);
          virtualPsd.baseUrl = u.toString();
        } catch { /* 注册表默认兜底 */ }
      }
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          ...virtualPsd,
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Filter out model-locked and excluded connections
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";
    const earliestExpiryFirst = providerOverride.earliestExpiryFirst === true;

    // Trigger non-blocking background quota checks if earliest-expiry is active and any account is missing/stale.
    // Skipped during an active channel breaker: the channel is being rejected wholesale (e.g. 11128),
    // so an extra upstream call only works against letting it clear — and a successful chat request
    // clears the breaker, after which this resumes on its own.
    const channelBlockLeftMs = channelBlockRemainingMs(settings.channelBlocks?.[providerId]);
    if (channelBlockLeftMs > 0) {
      log.debug("AUTH", `${providerId} | channel blocked (${Math.ceil(channelBlockLeftMs / 1000)}s left) — skipping quota refresh`);
    } else if (earliestExpiryFirst && availableConnections.length > 1) {
      triggerBackgroundQuotaRefresh(availableConnections);
    }

    // If earliestExpiryFirst is enabled, sort available connections so that the account
    // with the nearest future package expiration date is selected first.
    let orderedConnections = availableConnections;
    if (earliestExpiryFirst && availableConnections.length > 1) {
      const now = Date.now();
      orderedConnections = [...availableConnections].sort((a, b) => {
        const timeA = (a.earliestPackageExpiry && new Date(a.earliestPackageExpiry).getTime() > now)
          ? new Date(a.earliestPackageExpiry).getTime()
          : Infinity;
        const timeB = (b.earliestPackageExpiry && new Date(b.earliestPackageExpiry).getTime() > now)
          ? new Date(b.earliestPackageExpiry).getTime()
          : Infinity;

        if (timeA !== timeB) {
          return timeA - timeB;
        }
        return (a.priority || 999) - (b.priority || 999);
      });
    }

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = orderedConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...orderedConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...orderedConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority or earliest-expiry)
      connection = orderedConnections[0];
    }

    if (earliestExpiryFirst && connection?.earliestPackageExpiry) {
      log.info("AUTH", `${provider} | earliest-expiry selected ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"}) | expires in ${formatRetryAfter(connection.earliestPackageExpiry)} (${connection.earliestPackageName || "package"})`);
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number, channelScope: boolean }}
 *   `channelScope: true` means the caller must NOT try sibling accounts — the
 *   error belongs to the channel, not to this account.
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0, channelScope: false };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel, channelScope = false;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel, channelScope } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0, channelScope: false };

  // Channel-scope failures are not this account's fault: do NOT lock the account
  // (the caller sets a provider-wide block instead, so a later request is not
  // rejected by a stale per-account lock the channel never justified). The error
  // is still recorded on the connection so the dashboard row can explain the
  // failure instead of looking silently broken.
  if (channelScope) {
    const reason = typeof errorText === "string" ? errorText.slice(0, 500) : "Provider error";
    await updateProviderConnection(connectionId, {
      lastError: reason,
      errorCode: status,
      lastErrorAt: new Date().toISOString(),
    });
    if (provider && status && reason) {
      console.error(`❌ ${provider} [${status}]: ${reason}`);
    }
    return { shouldFallback: true, cooldownMs, channelScope: true };
  }

  // Keep enough of the upstream text for the UI to extract reset info
  // (quotaResetDelay / quotaResetTimeStamp live deep in the JSON body — a
  // 100-char cut dropped them and the friendly message rendered empty
  // placeholders). 500 is still short enough for the dashboard row.
  const reason = typeof errorText === "string" ? errorText.slice(0, 500) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs, channelScope: false };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
