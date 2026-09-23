/**
 * Settings re-organisation: the auto-compact toggle moved to Token Saver, and the
 * provider-transfer + daily check-in toggles moved to a new /dashboard/experimental
 * page.
 *
 * These are source guards, because the failure mode they prevent is invisible in
 * a browser: a half-move. The component keeps rendering, the switch still flips,
 * and nothing tells you that the page no longer owns the key it PATCHes (so the
 * setting silently stops being saved), or that the same toggle is rendered in two
 * places and they disagree.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel) => readFileSync(abs(rel), "utf8");
const literal = (lang) => JSON.parse(read(`public/i18n/literals/${lang}.json`));

const PROFILE = "src/app/(dashboard)/dashboard/profile/page.js";
const TOKEN_SAVER = "src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js";
const EXPERIMENTAL = "src/app/(dashboard)/dashboard/experimental/ExperimentalClient.js";
const QUOTA_PAGE_LIMITS = "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js";
const SIDEBAR = "src/shared/components/Sidebar.js";
const HEADER = "src/shared/components/Header.js";
const NEW_DESCRIPTION = "Beta toggles for provider tools, daily check-ins, and dashboard security";

// The four beta toggles that left Settings, with the settings key each one writes.
const MOVED_TOGGLES = [
  ["OAuth import / export", "codeBuddyOAuthImport"],
  ["Qoder auto daily credit claim", "qoderCheckin"],
  ["CodeBuddy daily active session", "codeBuddyIntlSession"],
  ["CodeBuddy CN auto daily check-in", "codeBuddyCheckin"],
];

describe("settings reorganisation", () => {
  it("ships the experimental page", () => {
    expect(existsSync(abs("src/app/(dashboard)/dashboard/experimental/page.js"))).toBe(true);
    expect(existsSync(abs(EXPERIMENTAL))).toBe(true);
  });

  it("renders every beta toggle on the experimental page and PATCHes its own key", () => {
    const src = read(EXPERIMENTAL);
    for (const [label, key] of MOVED_TOGGLES) {
      expect(src).toContain(`translate("${label}")`);
      // The key has to appear inside a PATCH body, not just as a read.
      expect(src).toMatch(new RegExp(`\\{\\s*${key}:`));
    }
    expect(src).toMatch(/fetch\("\/api\/settings",\s*\{[\s\S]*method:\s*"PATCH"/);
  });

  it("leaves nothing behind in Settings", () => {
    const src = read(PROFILE);
    for (const [label, key] of MOVED_TOGGLES) {
      expect(src).not.toContain(`translate("${label}")`);
      expect(src).not.toContain(key);
    }
    expect(src).not.toContain("Auto-compact oversized context");
    expect(src).not.toContain("autoCompactEnabled");
    expect(src).not.toContain("autoCompactRatio");
  });

  it("keeps the trial-provider toggle in Settings", () => {
    const src = read(PROFILE);
    expect(src).toContain('translate("Show trial providers")');
    expect(src).toContain("showCommunityProviders");
  });

  it("re-homes auto-compact in Token Saver, still defaulting to ON", () => {
    const src = read(TOKEN_SAVER);
    expect(src).toContain('translate("Auto-compact oversized context")');
    expect(src).toContain('translate("Trigger threshold")');
    expect(src).toContain("autoCompactEnabled: value");
    expect(src).toContain("autoCompactRatio: ratio");
    // Default-on: the stored flag is an opt-out, so the read must be `!== false`.
    expect(src).toContain("setAutoCompactEnabled(data.autoCompactEnabled !== false)");
    expect(src).not.toContain("data.autoCompactEnabled === true");
  });

  it("places auto-compact below the Lazy senior dev (Ponytail) row", () => {
    // Requested layout: the bottom "be lazy about it" group — Ponytail, then
    // auto-compact, then the (currently hidden) PXPIPE row.
    const src = read(TOKEN_SAVER);
    const lazy = src.indexOf("Lazy senior dev");
    const autoCompact = src.indexOf('translate("Auto-compact oversized context")');
    const pxpipe = src.indexOf("Compress prompts as images");
    expect(lazy).toBeGreaterThan(-1);
    expect(autoCompact).toBeGreaterThan(lazy);
    expect(pxpipe).toBeGreaterThan(autoCompact);
  });

  it("puts the sidebar entry between Console Log and Settings", () => {
    const src = read(SIDEBAR);
    const consoleLog = src.indexOf("/dashboard/console-log");
    const experimental = src.indexOf("/dashboard/experimental");
    const settings = src.indexOf('href="/dashboard/profile"');
    expect(consoleLog).toBeGreaterThan(-1);
    expect(experimental).toBeGreaterThan(consoleLog);
    expect(settings).toBeGreaterThan(experimental);
  });

  it("gives the new route a header title and description", () => {
    const src = read(HEADER);
    const start = src.indexOf('pathname.includes("/experimental")');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('if (pathname === "/dashboard")'));
    expect(block).toContain('title: "Experimental"');
    expect(block).toContain(NEW_DESCRIPTION);
  });

  it("homes the hide-no-quota view toggle on the experimental page, above OAuth import/export", () => {
    const src = read(EXPERIMENTAL);
    expect(src).toContain('translate("Hide no-quota provider cards")');
    expect(src).toContain("quotaHideNoQuota");
    // Client-side view pref — must NOT go through the settings PATCH path.
    expect(src).not.toMatch(/\{\s*quotaHideNoQuota:/);
    // Requested layout: the toggle sits above the OAuth import / export row.
    const hideNoQuota = src.indexOf('translate("Hide no-quota provider cards")');
    const oauthTransfer = src.indexOf('translate("OAuth import / export")');
    expect(oauthTransfer).toBeGreaterThan(hideNoQuota);
  });

  it("quota page keeps reading the pref but no longer renders a toolbar button", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    expect(src).toContain('localStorage.getItem("quotaHideNoQuota")');
    expect(src).not.toContain('translate("Hide no-quota');
    // No setter on this page anymore — the Experimental page owns the write.
    expect(src).not.toContain("setHideNoQuota");
  });

  it("collapses the two quota-row visibility buttons into one flip control (no second dropdown)", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    // One button that flips a plain, independently-persisted boolean — not two
    // buttons, not a <select>. The flip state is deliberately NOT derived from
    // whether `quotaVisibility` happens to hold a hidden row: that coupling let
    // a manually-hidden (or stale) row make the toggle read "on" while nothing
    // was actually hidden on screen, so a click flipped the label but changed
    // nothing ("翻转没有生效"). The boolean always mirrors what's rendered.
    expect(src).toContain("setHideDepleted((prev) => !prev)");
    expect(src).toMatch(/localStorage\.setItem\("quotaHideDepleted"/);
    // One button whose label flips with state — not two buttons, not a <select>.
    expect(src).toMatch(/translate\(hideDepleted \? "Show all" : "Only with balance"\)/);
    // The retired derived-state approach must not creep back.
    expect(src).not.toContain("depletedRowsHidden");
    expect(src).not.toContain("handleToggleDepletedFilter");
  });

  it("keeps the flip control's eye icon pointing the same way as its label", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    // Every toolbar sibling pairs icon↔label by MEANING: block/check_circle with
    // "Turn off Empty"/"Turn on Available", hourglass_top with "Expiring first".
    // The flip button's label names what the mode does, so "Only with balance"
    // (which hides the zero-balance rows) takes the struck-through eye and
    // "Show all" takes the open one. That is also the glyph the "Hidden:" chip
    // row uses, so the button and the chips agree. The inverse was what shipped
    // first and it made the icon contradict its own label.
    expect(src).toMatch(/\{hideDepleted \? "visibility" : "visibility_off"\}/);
    expect(src).not.toMatch(/\{hideDepleted \? "visibility_off" : "visibility"\}/);
  });

  it("explains an empty card body instead of collapsing to a bare chip row", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    // QuotaTable returns null for an empty list, so a card whose rows are all
    // hidden (CodeBuddy Intl had all 5 of its rows hidden) rendered as a "Hidden:"
    // chip row with no body — it looked broken rather than filtered.
    expect(src).toMatch(/visibleQuotas\.length === 0 && rawQuotas\.length > 0/);
    expect(src).toContain("All quota rows are hidden — use the chips below to show them");
    expect(src).toContain("No quota left to show — all rows are at zero balance");
  });

  it("applies hide/show edits without dropping clicks made in the same tick", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    // The "Hidden:" chips and the per-row hide buttons live in one card, so a
    // burst of clicks runs in a single tick. Reading `quotaVisibility` from the
    // render closure made every handler compute from the same pre-click
    // snapshot — the last PATCH won and the rest were silently dropped, so
    // clicking five chips restored only two rows. The edits must go through the
    // setState updater form so each one sees the previous.
    expect(src).toContain("setQuotaVisibility((current) => {");
    expect(src).toMatch(/const entryVisibility = current\[connectionId\] \|\| \{\}/);
    // The stale-closure form must not come back in either handler.
    const hide = src.slice(src.indexOf("const handleHideQuota"), src.indexOf("const handleShowQuota"));
    const show = src.slice(src.indexOf("const handleShowQuota"), src.indexOf("// Auto-refresh interval"));
    for (const [name, fn] of [["handleHideQuota", hide], ["handleShowQuota", show]]) {
      expect(fn, `${name} must not read the render-closure map`).not.toMatch(
        /const previous = quotaVisibility/,
      );
      expect(fn, `${name} should delegate to editQuotaVisibility`).toContain("editQuotaVisibility(");
    }
    // Antigravity group pruning must survive the refactor.
    expect(src).toContain("pruneAntigravityGroup");
  });

  it("reports the page count of what is actually rendered once a view filter drops cards", async () => {
    const { getVisiblePageSummary, getConnectionsPaginationSummary } = await import(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );
    // Backend summary counts the server's page — it knows nothing about the
    // client-side view filters, which is how "Showing 1-10 of 46" ended up
    // sitting above a grid of 12 cards.
    expect(
      getConnectionsPaginationSummary({ page: 1, pageSize: 10, total: 46, totalPages: 5 }),
    ).toBe("Showing 1-10 of 46");
    // The filtered variant describes the cards on screen instead.
    expect(getVisiblePageSummary(12, 10)).toBe("Showing 1-10 of 12");
    expect(getVisiblePageSummary(7, 10)).toBe("Showing 1-7 of 7");
    expect(getVisiblePageSummary(0, 10)).toBe("Showing 0 of 0");
    // Degenerate inputs must not produce "Showing 1-NaN of undefined".
    expect(getVisiblePageSummary(undefined, 10)).toBe("Showing 0 of 0");
    expect(getVisiblePageSummary(4, undefined)).toBe("Showing 1-4 of 4");

    // The page must actually choose between them, not hardcode one.
    const src = read(QUOTA_PAGE_LIMITS);
    expect(src).toContain("getVisiblePageSummary");
    expect(src).toMatch(
      /\{viewFilterActive \? visiblePageSummary : connectionsPageSummary\}/,
    );
    // The "only with balance" mode filters quota ROWS, not cards, so a
    // card-count comparison alone never trips. It has to be part of the
    // condition or the notice misses the very case it was written for.
    expect(src).toMatch(/const viewFilterActive =[\s\S]{0,200}hideDepleted \|\|/);
    // And it must tell the user why the two counts disagree.
    expect(src).toContain('translate(');
    expect(src).toMatch(/View filter is on: counts below cover the cards shown on this page/);
  });

  it("keeps the quota toolbar readable: translated tooltips + a visible refresh label", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    // The runtime i18n walker only translates text nodes, never `title`
    // attributes — so an icon-only toolbar button with a raw English `title`
    // shows English on hover for every non-English locale. Every toolbar
    // tooltip must go through translate().
    expect(src).toMatch(/title=\{translate\("Refresh all"\)\}/);
    expect(src).toMatch(/title=\{translate\("Filter quota providers"\)\}/);
    expect(src).toMatch(/title=\{translate\(autoRefresh \? "Disable auto-refresh" : "Enable auto-refresh"\)\}/);
    expect(src).not.toMatch(/title="Refresh all"/);
    expect(src).not.toMatch(/title="Disable auto-refresh"/);
    // The auto-refresh button keeps a visible label, not a bare icon.
    expect(src).toContain('{translate("Auto-refresh")}');
  });

  it("has both Chinese dictionaries for every string the move introduced", () => {
    for (const lang of ["zh-CN", "zh-TW"]) {
      const dict = literal(lang);
      expect(dict["Experimental"]).toBeTruthy();
      expect(dict[NEW_DESCRIPTION]).toBeTruthy();
      for (const [label] of MOVED_TOGGLES) expect(dict[label]).toBeTruthy();
      expect(dict["Auto-compact oversized context"]).toBeTruthy();
      expect(dict["Hide no-quota provider cards"]).toBeTruthy();
      expect(dict["Quota page view: hide cards that have no quota to display"]).toBeTruthy();
      expect(dict["Only with balance"]).toBeTruthy();
      expect(dict["Show all"]).toBeTruthy();
      // Toolbar tooltips wired through translate() (bug: raw `title` showed
      // English on hover for zh users after the buttons went icon-only).
      expect(dict["Refresh all"]).toBeTruthy();
      expect(dict["Disable auto-refresh"]).toBeTruthy();
      expect(dict["Enable auto-refresh"]).toBeTruthy();
      expect(dict["Show all quota packs across current connections"]).toBeTruthy();
      expect(dict["Hide depleted (zero-balance) quota packs across current connections"]).toBeTruthy();
      // Explains why the visible-count and the backend page count differ once a
      // view filter is on — without it the numbers just look broken.
      expect(
        dict["View filter is on: counts below cover the cards shown on this page. Paging still follows all connections."],
      ).toBeTruthy();
      // Empty-body explanations (a card whose rows are all hidden).
      expect(dict["All quota rows are hidden — use the chips below to show them"]).toBeTruthy();
      expect(dict["No quota left to show — all rows are at zero balance"]).toBeTruthy();
    }
    // Retired keys must be fully removed — a stale key would silently fall
    // back to English if code ever referenced it again.
    for (const lang of ["zh-CN", "zh-TW"]) {
      const dict = literal(lang);
      expect(dict["Beta toggles for provider transfer and daily credit check-ins"]).toBeUndefined();
      expect(dict["Hide no-quota"]).toBeUndefined();
      expect(dict["Hide cards with no quota to display"]).toBeUndefined();
    }
  });
});
