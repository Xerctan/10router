// Issue #9, item 3 — "no password set falls back to the literal 123456".
//
// That fallback combined with the 0.0.0.0 listener made a fresh install
// admin-open to the whole LAN in one guess (and the settings PATCH accepted the
// same literal, so a remote caller could even set the password). The login page
// advertised it on screen. All three are gone; the only non-interactive
// bootstrap left is INITIAL_PASSWORD, and with nothing configured at all the
// dashboard is loopback-only (guard tests live in dashboard-guard.test.js).
//
// The second half pins the deliberate trade-off: a request may not merely
// *look* local, it has to come through custom-server.js's peer stamping.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";

// `@/lib/dataDir` resolves DATA_DIR at import time and runs the legacy
// ~/.9router migration when unset — point it at a throwaway dir first.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-bootstrap-"));
process.env.DATA_DIR = tempDir;
process.env.JWT_SECRET = "test-secret-for-bootstrap-auth";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

const { verifyDashboardPassword, isDashboardAuthConfigured } = await import(
  "@/lib/auth/dashboardSession.js"
);

const FORBIDDEN_LITERAL = "1234" + "56";

function readSource(relative) {
  return fs.readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
}

// Comments in this repo explain *why* the literal was removed, so they mention
// it. Only executable text may be checked.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

describe("dashboard password verification", () => {
  const originalBootstrap = process.env.INITIAL_PASSWORD;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INITIAL_PASSWORD;
  });

  afterEach(() => {
    if (originalBootstrap === undefined) delete process.env.INITIAL_PASSWORD;
    else process.env.INITIAL_PASSWORD = originalBootstrap;
  });

  it("rejects the old default literal when nothing is configured", async () => {
    mocks.getSettings.mockResolvedValue({});

    expect(await verifyDashboardPassword(FORBIDDEN_LITERAL)).toBe(false);
  });

  it("rejects every other guess when nothing is configured", async () => {
    mocks.getSettings.mockResolvedValue({});

    expect(await verifyDashboardPassword("hunter2")).toBe(false);
    expect(await verifyDashboardPassword("")).toBe(false);
    expect(await verifyDashboardPassword(undefined)).toBe(false);
    expect(await verifyDashboardPassword(null)).toBe(false);
  });

  it("accepts INITIAL_PASSWORD as the only bootstrap password", async () => {
    mocks.getSettings.mockResolvedValue({});
    process.env.INITIAL_PASSWORD = "from-env-secret";

    expect(await verifyDashboardPassword("from-env-secret")).toBe(true);
    expect(await verifyDashboardPassword(FORBIDDEN_LITERAL)).toBe(false);
    expect(await verifyDashboardPassword("from-env-secre")).toBe(false);
  });

  it("prefers the stored hash and ignores the bootstrap env", async () => {
    const hash = await bcrypt.hash("real-password", 4);
    mocks.getSettings.mockResolvedValue({ password: hash });
    process.env.INITIAL_PASSWORD = "from-env-secret";

    expect(await verifyDashboardPassword("real-password")).toBe(true);
    expect(await verifyDashboardPassword("from-env-secret")).toBe(false);
    expect(await verifyDashboardPassword(FORBIDDEN_LITERAL)).toBe(false);
  });
});

describe("isDashboardAuthConfigured", () => {
  const originalBootstrap = process.env.INITIAL_PASSWORD;

  beforeEach(() => {
    delete process.env.INITIAL_PASSWORD;
  });

  afterEach(() => {
    if (originalBootstrap === undefined) delete process.env.INITIAL_PASSWORD;
    else process.env.INITIAL_PASSWORD = originalBootstrap;
  });

  it("is false when there is no password, no bootstrap env and no SSO", () => {
    expect(isDashboardAuthConfigured({})).toBe(false);
    expect(isDashboardAuthConfigured(null)).toBe(false);
    expect(isDashboardAuthConfigured(undefined)).toBe(false);
  });

  it("is true for a stored password hash", () => {
    expect(isDashboardAuthConfigured({ password: "$2a$10$hash" })).toBe(true);
  });

  it("is true for the bootstrap env var", () => {
    process.env.INITIAL_PASSWORD = "x";
    expect(isDashboardAuthConfigured({})).toBe(true);
  });

  it("is true only for a complete OIDC configuration", () => {
    const ready = {
      oidcIssuerUrl: "https://idp.example.com",
      oidcClientId: "client",
      oidcClientSecret: "secret",
    };
    expect(isDashboardAuthConfigured(ready)).toBe(true);
    expect(isDashboardAuthConfigured({ ...ready, oidcClientSecret: "  " })).toBe(false);
    expect(isDashboardAuthConfigured({ ...ready, oidcClientId: undefined })).toBe(false);
  });

  it("is true only for a complete SAML configuration", () => {
    expect(isDashboardAuthConfigured({ samlEntryPoint: "https://idp/sso", samlCert: "cert" })).toBe(true);
    expect(isDashboardAuthConfigured({ samlEntryPoint: "https://idp/sso" })).toBe(false);
    expect(isDashboardAuthConfigured({ samlCert: "cert" })).toBe(false);
  });
});

describe("the CLI reset flow no longer revives a public password", () => {
  const cli = readSource("cli/src/cli/menus/settings.js");

  it("does not hardcode a reset password", () => {
    expect(codeOnly(cli)).not.toContain(FORBIDDEN_LITERAL);
    expect(cli).not.toContain("DEFAULT_PASSWORD");
  });

  it("generates a random password and stores it through the settings API", () => {
    expect(cli).toContain("crypto");
    expect(cli).toContain("generatePassword()");
    expect(cli).toContain("newPassword: generated");
  });

  it("shows the generated password exactly once instead of a default", () => {
    expect(cli).toContain('resetPwDone", { password: generated }');
  });

  it("the CLI locales no longer mention a default password", () => {
    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      const json = JSON.parse(readSource(`cli/src/cli/i18n/locales/${locale}/settings.json`));
      expect(json["menus.settings.resetPwConfirm"]).not.toContain("{default}");
      expect(json["menus.settings.resetPwDone"]).toContain("{password}");
    }
  });
});

describe("the 'set a password' advice leads somewhere", () => {
  // The profile page used to test `requireLogin === true`, but the server's
  // default is ON and an install that never touched the setting has no key at
  // all — so the toggle rendered OFF and the password form was hidden on
  // exactly the instances that had no password yet. Every other reader of this
  // setting uses `!== false`; the form has to as well, or the guidance the
  // dashboard shows in that state is a dead end.
  const profile = readSource("src/app/(dashboard)/dashboard/profile/page.js");

  it("does not use the strict check that hides the form", () => {
    expect(profile).not.toContain("settings.requireLogin === true");
  });

  it("renders the toggle and the password form with the server's default", () => {
    expect(profile).toContain("checked={settings.requireLogin !== false}");
    expect(profile).toContain("{settings.requireLogin !== false && (");
  });

  it("flips the setting the right way when the key is absent", () => {
    // `!settings.requireLogin` on an absent key is true, so the switch would
    // look unresponsive: click -> set true -> still on.
    expect(profile).not.toContain("updateRequireLogin(!settings.requireLogin)");
    expect(profile).toContain("updateRequireLogin(settings.requireLogin === false)");
  });
});

describe("the security card read-out does not contradict itself", () => {
  const card = readSource("src/app/(dashboard)/dashboard/experimental/SecurityCard.js");

  it("reports the effective scope, not just the switch", () => {
    expect(card).toContain("localOnlyEffective");
    expect(card).toContain("noPassword && !loginOff");
  });

  it("drops the sentence that called the dashboard remote-reachable and unreachable at once", () => {
    expect(card).not.toContain("so remote dashboard access is disabled until one exists");
  });

  it("says what to do and that the gateway API keeps working", () => {
    expect(card).toContain("The gateway API (/v1) is unaffected.");
  });
});

describe("the fnOS package does not ship a public initial password", () => {
  const main = readSource("fnos-packaging/cmd/main");

  it("generates the first password instead of writing a literal", () => {
    expect(main).not.toContain("INITIAL_PASSWORD=" + FORBIDDEN_LITERAL);
    expect(main).toContain("GEN_PW=");
    expect(main).toContain("crypto");
  });

  it("reads the value back from .env instead of overriding it with a constant", () => {
    // Process env beats .env for Next.js, so a constant fallback here would
    // silently replace the generated password.
    expect(main).not.toContain('INITIAL_PASSWORD="${INITIAL_PASSWORD:-' + FORBIDDEN_LITERAL + '}"');
    expect(main).toContain("sed -n 's/^INITIAL_PASSWORD=//p'");
  });

  it("the install and upgrade callbacks replace the placeholder with a random value", () => {
    for (const hook of ["install_callback", "upgrade_callback"]) {
      const code = readSource(`fnos-packaging/cmd/${hook}`);
      expect(code).not.toContain("INITIAL_PASSWORD=" + FORBIDDEN_LITERAL);
      expect(code).toContain("gen_initial_password");
    }
  });
});

describe("no default password survives anywhere in the executable paths", () => {
  it("dashboardSession no longer defines or compares a default password", () => {
    const code = codeOnly(readSource("src/lib/auth/dashboardSession.js"));
    expect(code).not.toContain(FORBIDDEN_LITERAL);
    expect(code).not.toContain("DEFAULT_PASSWORD");
    expect(code).toContain("INITIAL_PASSWORD");
  });

  it("the settings PATCH no longer accepts the default literal", () => {
    const code = codeOnly(readSource("src/app/api/settings/route.js"));
    expect(code).not.toContain(FORBIDDEN_LITERAL);
  });

  it("the login page no longer advertises a default password", () => {
    const code = codeOnly(readSource("src/app/login/page.js"));
    expect(code).not.toContain(FORBIDDEN_LITERAL);
    expect(code.toLowerCase()).not.toContain("default password");
  });

  it("the login page explains both bootstrap states instead of a bare form", () => {
    const code = readSource("src/app/login/page.js");
    expect(code).toContain("needsLocalSetup");
    expect(code).toContain("bootstrapLocal");
  });
});

describe("guard wiring for the bootstrap state and the local-only switch", () => {
  const guard = readSource("src/dashboardGuard.js");

  it("trusts loopback only when nothing is configured, and only for that state", () => {
    const code = codeOnly(guard);
    // isAuthenticated (management APIs) …
    expect(code).toContain("!isDashboardAuthConfigured(settings) && isLocalRequest(request)");
    // … and the /dashboard HTML branch, which checks the cookie directly.
    expect(code).toContain("!isDashboardAuthConfigured(dashboardSettings) && isLocalRequest(request)");
  });

  it("enforces dashboardLocalOnly and leaves the LLM API out of it", () => {
    const code = codeOnly(guard);
    expect(code).toContain("dashboardLocalOnly === true");
    // The switch is only consulted for non-LLM paths.
    expect(code).toContain("if (!isPublicLlmApi(pathname)) {");
  });

  it("keeps the dashboard-local-only refusal machine-readable", () => {
    expect(guard).toContain("The dashboard is set to local-only access");
  });
});

describe("security read-out wiring", () => {
  it("exposes the facts the Security card renders", () => {
    const code = readSource("src/app/api/security/status/route.js");
    for (const field of ["dashboardLocalOnly", "hasPassword", "bootstrapPassword", "requireLogin", "lanAddresses"]) {
      expect(code).toContain(field);
    }
  });

  it("the card toggles the setting the guard enforces", () => {
    const code = readSource("src/app/(dashboard)/dashboard/experimental/SecurityCard.js");
    expect(code).toContain("dashboardLocalOnly");
    expect(code).toContain("/api/security/status");
  });

  it("is mounted on the experimental page", () => {
    const code = readSource("src/app/(dashboard)/dashboard/experimental/ExperimentalClient.js");
    expect(code).toContain("SecurityCard");
  });
});
