/**
 * §5.1 / §5.2 / §5.3 of docs/zh-CN/impl-plan-issue24-25-agent.md.
 *
 * `cli/cli.js` is a launcher script, not a module: importing it starts a server.
 * The only entry point that exits before any spawn is `--help`, so the real
 * behavioural check here is that `--help` renders in every locale (argv parsing
 * intact) and advertises the new flag. Everything else is a source guard —
 * deliberately narrow regexes over one file, so a refactor that drops the
 * no-TTY SIGHUP exemption or re-swallows the tray error fails loudly.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/cli.js", import.meta.url));
const LANGS = ["en", "zh-CN", "zh-TW"];

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(abs(rel), "utf8"));
const coreJson = (lang) => readJson(`cli/src/cli/i18n/locales/${lang}/core.json`);

// Node's locale detection is env-driven; TENROUTER_LANG pins it so the expected
// strings below are deterministic.
const helpCache = new Map();
function help(lang) {
  if (!helpCache.has(lang)) {
    helpCache.set(
      lang,
      execFileSync(process.execPath, [CLI, "--help"], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 25000,
        env: { ...process.env, TENROUTER_LANG: lang },
      }),
    );
  }
  return helpCache.get(lang);
}

describe("CLI --help advertises --no-tray", () => {
  it(
    "renders in all three locales and lists the flag",
    () => {
      for (const lang of LANGS) {
        const out = help(lang);
        expect(out.length, lang).toBeGreaterThan(100);
        expect(out, lang).toContain("--no-tray");
        expect(out, lang).toContain("--tray");
      }
      expect(help("en")).toContain("Don't create a tray icon");
      expect(help("zh-CN")).toContain("不创建托盘图标");
      expect(help("zh-TW")).toContain("不建立托盤圖示");
    },
    60000,
  );
});

describe("CLI tray locale strings", () => {
  it("has the honest tray messages in every dictionary", () => {
    for (const lang of LANGS) {
      const dict = coreJson(lang);
      for (const key of ["launcher.trayUnavailable", "launcher.traySkipped"]) {
        expect(typeof dict[key], `${lang}:${key}`).toBe("string");
        expect(dict[key].length, `${lang}:${key}`).toBeGreaterThan(0);
      }
      // the warn site interpolates the real error message
      expect(dict["launcher.trayUnavailable"], lang).toContain("{error}");
    }
  });

  it("keeps help.text valid JSON with the new option line", () => {
    for (const lang of LANGS) {
      const dict = coreJson(lang);
      expect(dict["help.text"], lang).toContain("--no-tray");
      expect(dict["help.text"], lang).toContain("--skip-update");
    }
  });
});

describe("CLI launcher source guards", () => {
  const src = readFileSync(CLI, "utf8");

  it("parses --no-tray into a flag", () => {
    expect(src).toMatch(/args\[i\] === "--no-tray"[\s\S]{0,80}noTray = true/);
  });

  it("skips tray init when --no-tray was given", () => {
    expect(src).toMatch(/const initTrayIcon = \(\) => \{[\s\S]{0,400}if \(noTray\) return false;/);
  });

  it("reports a tray failure instead of swallowing it", () => {
    expect(src).toContain('t("launcher.trayUnavailable"');
    expect(src).not.toContain("// Tray not available - continue without it");
  });

  it("does not claim the tray is ready when no icon was created", () => {
    expect(src).toMatch(/if \(initTrayIcon\(\)\) \{[\s\S]{0,200}t\("launcher.trayReady"\)/);
  });

  it("ignores SIGHUP when there is no TTY (nohup / systemd)", () => {
    expect(src).toContain("const ignoreSighup = !process.stdout.isTTY;");
    expect(src).toMatch(/if \(ignoreSighup\) return;/);
    // and keeps the original shut-down path for an attached terminal
    expect(src).toContain('t("launcher.exiting")');
  });

  it("keeps tray mode's own SIGHUP exemption", () => {
    expect(src).toContain('process.removeAllListeners("SIGHUP")');
  });
});

describe("CLI publish metadata & docs", () => {
  it("points npm at the repository, readme and issue tracker", () => {
    const pkg = readJson("cli/package.json");
    expect(pkg.repository).toMatchObject({
      type: "git",
      url: "git+https://github.com/techysy/10router.git",
      directory: "cli",
    });
    expect(pkg.homepage).toContain("github.com/techysy/10router");
    expect(pkg.bugs?.url).toBe("https://github.com/techysy/10router/issues");
  });

  it("documents the headless start in both READMEs", () => {
    for (const rel of ["cli/README.md", "cli/README.zh-CN.md"]) {
      const md = readFileSync(abs(rel), "utf8");
      expect(md, rel).toContain("--no-tray");
      expect(md, rel).toMatch(/nohup/);
      expect(md, rel).toMatch(/systemd/);
    }
  });
});
