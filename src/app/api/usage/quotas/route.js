// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnections } from "@/lib/localDb";
import { AI_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { computeConnectionUsage } from "../[connectionId]/route.js";

/**
 * GET /api/usage/quotas — read-only quota overview of every usage-capable
 * provider connection, in the same normalized shape the dashboard's
 * Provider Limits cards render (parseQuotaData).
 *
 * Built for external dashboards such as CreditDaddy: the guard lets it through
 * with a dashboard virtual key (sk-…) as well as the usual session/CLI token.
 * The response never contains credentials — only ids, labels and quota numbers.
 *
 * Upstream quota APIs are rate-sensitive, so results are cached per connection
 * for CACHE_TTL_MS; `?force=1` bypasses the cache. Connections are fetched with
 * bounded concurrency and a per-connection timeout, so one slow provider cannot
 * stall the whole overview.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const CONCURRENCY = 4;
const PER_CONNECTION_TIMEOUT_MS = 25_000;
const cache = new Map(); // connectionId → { at, entry }

export function isUsageEligible(connection) {
  if (connection.authType === "oauth") return true;
  const isApikey = connection.authType === "apikey" || connection.authType === "api_key";
  return isApikey && USAGE_APIKEY_PROVIDERS.includes(connection.provider);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function quotaEntry(connection, force) {
  const base = {
    id: connection.id,
    provider: connection.provider,
    providerName: AI_PROVIDERS[connection.provider]?.name || connection.provider,
    name: connection.name || null,
    email: connection.email || null,
    isActive: connection.isActive !== false,
    authType: connection.authType || null,
  };
  const hit = cache.get(connection.id);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...base, ...hit.entry, cached: true };

  let entry;
  try {
    const { status, body } = await withTimeout(computeConnectionUsage(connection, { force }), PER_CONNECTION_TIMEOUT_MS);
    if (status !== 200 || body?.error) {
      entry = { quotas: [], error: body?.error || `HTTP ${status}` };
    } else {
      entry = {
        plan: typeof body?.plan === "string" ? body.plan : null,
        quotas: parseQuotaData(connection.provider, body),
        message: typeof body?.message === "string" ? body.message : null,
        limitReached: body?.limitReached === true,
      };
    }
  } catch (error) {
    entry = { quotas: [], error: error.message };
  }
  entry.checkedAt = new Date().toISOString();
  // Errors are cached too (briefly-lived by the same TTL) so a broken
  // connection is not re-hammered on every poll; ?force=1 retries at once.
  cache.set(connection.id, { at: Date.now(), entry });
  return { ...base, ...entry, cached: false };
}

export async function GET(request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  let connections;
  try {
    connections = (await getProviderConnections()).filter(isUsageEligible);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const results = new Array(connections.length);
  let next = 0;
  const worker = async () => {
    while (next < connections.length) {
      const i = next++;
      results[i] = await quotaEntry(connections[i], force);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, connections.length) }, worker));

  // Drop cache entries of connections that no longer exist.
  const alive = new Set(connections.map((c) => c.id));
  for (const id of cache.keys()) if (!alive.has(id)) cache.delete(id);

  return Response.json({ generatedAt: new Date().toISOString(), connections: results });
}

export const __test__ = { cache };
