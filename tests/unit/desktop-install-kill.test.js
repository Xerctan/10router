// 升级安装锁文件回归（2026-10-02 实测：v1.3.0 → 1.3.1 安装报
// “Failed to uninstall old application files”）——sidecar 与托盘是同一个
// 10Router.exe（ELECTRON_RUN_AS_NODE 无窗进程），旧版卸载器杀不掉它。
// 两道防线钉形状：NSIS customInit 安装前强杀；退出路径确定性停 sidecar。
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

describe("installer pre-kill (covers upgrades FROM old versions)", () => {
  const nsh = read("desktop/nsis/installer.nsh");

  it("customInit force-kills the 10Router process tree before the old uninstaller runs", () => {
    expect(nsh).toContain("!macro customInit");
    expect(nsh).toMatch(/taskkill \/F \/IM 10Router\.exe \/T/);
    // 强杀后给文件锁留释放窗口
    expect(nsh).toMatch(/Sleep \d{3,}/);
  });

  it("the include script is registered with electron-builder", () => {
    const pkg = JSON.parse(read("desktop/package.json"));
    expect(pkg.build.nsis.include).toBe("nsis/installer.nsh");
    expect(fs.existsSync(new URL("../../desktop/nsis/installer.nsh", import.meta.url))).toBe(true);
  });
});

describe("deterministic shutdown (covers quit-then-install same-version flow)", () => {
  const main = read("desktop/main.js");

  it("before-quit runs stopServer before exiting", () => {
    const beforeQuit = main.slice(main.indexOf("before-quit"));
    expect(beforeQuit).toContain("e.preventDefault()");
    expect(beforeQuit).toContain("stopServer()");
    expect(beforeQuit).toContain("app.exit(0)");
  });

  it("the in-app updater stops the sidecar BEFORE spawning the installer", () => {
    const idx = main.lastIndexOf("tr('update.installNow')");
    const segment = main.slice(idx, idx + 1200);
    expect(segment.indexOf("await stopServer()")).toBeGreaterThan(-1);
    expect(segment.indexOf("await stopServer()")).toBeLessThan(segment.indexOf("spawn(file"));
  });

  it("will-quit keeps the taskkill backstop", () => {
    expect(main).toContain("app.on('will-quit'");
    expect(main).toContain("killProcTree(nodeProc.pid)");
  });
});
