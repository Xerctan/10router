import { NextResponse } from "next/server";
import { openTransfer } from "@/lib/auth/secureTransfer";
import { importAccounts } from "@/lib/oauth/accountTransfer";
import {
  looksLikeBigmodelKey,
  mintBigmodelKey,
  pickZcodeImportMaterial,
} from "@/lib/oauth/providers/zcode.js";

/**
 * POST /api/oauth/zcode/import
 * Import ZCode accounts from an encrypted transfer blob — the same
 * 10router-oauth-secure-v1 envelope CreditDaddy exports (and 10router's own
 * transfer/export produces). Body: { passphrase, blob }.
 *
 * Authorization = the transfer passphrase itself (GCM tag proves possession),
 * matching /api/oauth/transfer/import; the guard lets same-machine requests
 * through and requires JWT/CLI otherwise.
 *
 * Per-account shapes are normalized by pickZcodeImportMaterial (plain transfer
 * accounts and CreditDaddy's marker + meta.credentials). The bigmodel material
 * is minted into a standard API key when needed (biz API). Z.AI-side accounts
 * are rejected in v1 with an explicit message: the zai key does not work on
 * the bigmodel endpoints this provider targets. Credentials are never echoed
 * back in the response.
 */

const ZAI_V1_MESSAGE =
  "Z.AI-side ZCode accounts are not supported yet — this provider targets the bigmodel side.";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ error: `Invalid JSON body: ${err.message}` }, { status: 400 });
  }
  const { passphrase, blob } = body || {};
  if (!passphrase || !blob) {
    return NextResponse.json({ error: "passphrase and blob required" }, { status: 400 });
  }

  let opened;
  try {
    opened = openTransfer(blob, passphrase);
  } catch (error) {
    if (error.message === "WRONG_PASSWORD") {
      return NextResponse.json({ error: "Wrong passphrase" }, { status: 401 });
    }
    return NextResponse.json({ error: "Unreadable transfer file" }, { status: 400 });
  }

  const items = Array.isArray(opened?.accounts) ? opened.accounts : [];
  if (items.length === 0) {
    return NextResponse.json({ error: "Transfer file contains no accounts" }, { status: 400 });
  }

  const toImport = [];
  const results = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      if (!item || typeof item !== "object") throw new Error("Item is not an object");
      const material = pickZcodeImportMaterial(item);
      if (!material || !material.token) throw new Error("No ZCode credential material found in this entry");
      if (material.provider === "zai") throw new Error(ZAI_V1_MESSAGE);

      let fullKey = material.token;
      if (!looksLikeBigmodelKey(fullKey)) {
        // Provider token (JWT / opaque) → mint the standard key via the biz API.
        const minted = await mintBigmodelKey(fullKey);
        fullKey = minted.fullKey;
      }

      const uid = material.uid || null;
      toImport.push({
        accessToken: fullKey,
        // "apikey" (no underscore) — the value importAccounts gates the
        // apiKey field write on, so the credential lands in both fields.
        authType: "apikey",
        name: item?.name || (uid ? `ZCode ${uid}` : "ZCode"),
        email: uid ? `${uid}@zcode` : item?.email || null,
        providerSpecificData: {
          ...(item?.providerSpecificData && typeof item.providerSpecificData === "object" ? item.providerSpecificData : {}),
          zcodeUserId: uid,
          zcodeProvider: "bigmodel",
          authMethod: "creditdaddy-import",
        },
      });
      results.push({ index: i, ok: true });
    } catch (e) {
      results.push({ index: i, ok: false, error: e.message || "Unknown error" });
      failed++;
    }
  }

  if (toImport.length > 0) {
    const summary = await importAccounts("zcode", toImport);
    imported = summary.imported;
    updated = summary.updated;
    skipped = summary.skipped;
    // Re-align per-item results: importAccounts only received the entries that
    // survived minting, so fold its outcomes back onto the original indexes.
    const summaryResults = summary.results || [];
    let r = 0;
    for (let i = 0; i < results.length; i++) {
      if (!results[i].ok) continue;
      const s = summaryResults[r++] || {};
      if (s.ok) {
        results[i] = { index: i, ok: true, ...(s.created ? { created: true } : {}), ...(s.updated ? { updated: true } : {}), id: s.id };
      } else {
        results[i] = { index: i, ok: false, error: s.error || "Import failed" };
        failed++;
      }
    }
  }

  return NextResponse.json({ imported, updated, skipped, failed, results });
}
