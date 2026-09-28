import { NextResponse } from "next/server";
import { getProviderConnections, createProviderConnection, updateProviderConnection } from "@/models";
import { readZcodeLocalInstall } from "@/lib/oauth/zcodeLocalInstall.js";
import {
  looksLikeBigmodelKey,
  mintBigmodelKey,
  buildZcodeConnectionPayload,
  findZcodeConnection,
} from "@/lib/oauth/providers/zcode.js";

/**
 * GET /api/oauth/zcode/auto-import
 * Scan the local ZCode desktop install (~/.zcode/v2) for bigmodel-side
 * credential material and land it as zcode connection(s).
 *
 * Host-secret reader: ALWAYS_PROTECTED + LOCAL_ONLY in the dashboard guard —
 * same class as the cursor/kiro/xiaomi auto-import siblings.
 *
 * Preference order per scan: cached minted keys (offline) → config.json
 * plaintext keys (offline) → provider access_token (needs a biz-API mint).
 * Z.AI-side material is skipped: the zai key does not work on the bigmodel
 * endpoints this provider targets. Credentials are never echoed back.
 */
export async function GET() {
  let scan;
  try {
    scan = await readZcodeLocalInstall();
  } catch (err) {
    return NextResponse.json({ found: false, error: err.message }, { status: 500 });
  }

  const { candidates, notes } = scan;
  if (!candidates || candidates.length === 0) {
    return NextResponse.json({
      found: false,
      error: "No usable ZCode bigmodel credentials found in ~/.zcode/v2 (oauth-mode accounts need ZCode desktop logged in on this machine).",
      notes,
    });
  }

  const connections = await getProviderConnections({ provider: "zcode" });
  const results = [];
  let imported = 0;
  let updated = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      let fullKey = candidate.fullKey;
      if (!fullKey) {
        if (candidate.kind !== "bigmodel") throw new Error("Only bigmodel-side ZCode accounts are supported");
        const minted = await mintBigmodelKey(candidate.token);
        fullKey = minted.fullKey;
      } else if (!looksLikeBigmodelKey(fullKey)) {
        throw new Error("Stored key has an unexpected format");
      }
      const payload = buildZcodeConnectionPayload({
        fullKey,
        userId: candidate.userId,
        authMethod: "local-import",
      });
      const existing = findZcodeConnection(connections, { userId: candidate.userId, key: fullKey });
      const connection = existing
        ? await updateProviderConnection(existing.id, { ...payload, resetErrorState: true })
        : await createProviderConnection(payload);
      if (existing) updated++;
      else {
        imported++;
        connections.push(connection);
      }
      results.push({
        ok: true,
        source: candidate.source,
        ...(existing ? { updated: true, id: existing.id } : { created: true, id: connection.id }),
      });
    } catch (err) {
      failed++;
      results.push({ ok: false, source: candidate.source, error: err.message });
    }
  }

  return NextResponse.json({
    found: imported + updated > 0,
    imported,
    updated,
    failed,
    results,
    notes,
  });
}
