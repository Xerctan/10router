// 统一 HTML 更新窗（desktop/update-window.html + preload-update.js）形状钉：
// 新窗口资产存在且被 main.js 引用、进 build.files 白名单（历史坑：漏登记打包后
// 功能静默消失）；状态机关键分支；更新流不再出现原生 dialog/data-URL 进度窗；
// 安全面（contextIsolation/sandbox/本地 file 页面）；新增 i18n key 三语完整。
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const exists = (rel) => fs.existsSync(new URL(`../../${rel}`, import.meta.url));

describe("unified HTML update window", () => {
    const main = read("desktop/main.js");
    const html = read("desktop/update-window.html");
    const preload = read("desktop/preload-update.js");
    const pkg = JSON.parse(read("desktop/package.json"));

    it("window assets exist on disk and are referenced from main.js", () => {
        expect(exists("desktop/update-window.html")).toBe(true);
        expect(exists("desktop/preload-update.js")).toBe(true);
        expect(main).toContain("update-window.html");
        expect(main).toContain("preload-update.js");
        expect(main).toContain("loadFile(UPDATE_HTML)");
    });

    it("build.files ships the new assets (漏登记=打包后静默消失)", () => {
        expect(pkg.build.files).toContain("update-window.html");
        expect(pkg.build.files).toContain("preload-update.js");
    });

    it("the update flow no longer uses native dialogs or the data-URL progress window", () => {
        const flow = main.slice(main.indexOf("async function checkForUpdates()"), main.indexOf("function showAbout()"));
        expect(flow).not.toContain("dialog.showMessageBox");
        expect(flow).not.toContain("dialog.showErrorBox");
        expect(flow).not.toContain("data:text/html");
        expect(main).not.toContain("downloadWithProgress");
    });

    it("state machine covers checking/available/downloading/ready/error/latest", () => {
        for (const s of ["checking", "available", "downloading", "ready", "error", "latest"]) {
            expect(main).toContain(`sendUpdateState('${s}'`);
        }
        // 关窗即取消下载：closed 处理器 abort 下载中的 AbortController
        const closed = main.slice(main.indexOf("updateWin.on('closed'"));
        expect(closed).toContain("updateDlCtrl.abort()");
        // 下载中仍推任务栏进度
        expect(main).toContain("updateWin.setProgressBar(");
    });

    it("keeps the behavior contract: ?check=1, releases fallback, stopServer before spawn", () => {
        expect(main).toContain("/api/version?check=1");
        expect(main).toContain("shell.openExternal(RELEASES_URL)");
        const idx = main.lastIndexOf("tr('update.installNow')");
        const segment = main.slice(idx, idx + 1200);
        expect(segment.indexOf("await stopServer()")).toBeGreaterThan(-1);
        expect(segment.indexOf("await stopServer()")).toBeLessThan(segment.indexOf("spawn(file"));
    });

    it("window is frameless with hardened webPreferences, preload uses contextBridge only", () => {
        const winDef = main.slice(main.indexOf("function openUpdateWindow()"), main.indexOf("updateWin.loadFile"));
        expect(winDef).toContain("frame: false");
        expect(winDef).toContain("contextIsolation: true");
        expect(winDef).toContain("nodeIntegration: false");
        expect(winDef).toContain("sandbox: true");
        expect(preload).toContain("contextBridge.exposeInMainWorld");
        expect(preload).not.toMatch(/require\((?!'electron')/);   // 只引 electron
        expect(preload).not.toContain("nodeIntegration");
    });

    it("the page loads no remote resources and follows the dashboard palette", () => {
        expect(html).not.toMatch(/src=["']https?:/i);
        expect(html).not.toMatch(/href=["']https?:/i);
        expect(html).toContain("Content-Security-Policy");
        expect(html).toContain("prefers-color-scheme");
        expect(html).toContain("#D97757");         // 品牌主色(src/shared/constants/colors.js)
        expect(html).toContain("closeBtn");        // 无边框窗的自定义关闭按钮
        expect(html).toContain("Escape");
    });

    it("every new update-window string has en, zh-CN and zh-TW text", () => {
        const keys = ["update.windowTitle", "update.checking", "update.cancel", "update.retry"];
        const zhTWStart = main.indexOf("    'zh-TW': {");
        const blocks = {
            en: main.slice(main.indexOf("    en: {"), main.indexOf("    'zh-CN': {")),
            "zh-CN": main.slice(main.indexOf("    'zh-CN': {"), zhTWStart),
            "zh-TW": main.slice(zhTWStart, main.indexOf("\n};", zhTWStart)),
        };
        for (const key of keys) {
            for (const [loc, block] of Object.entries(blocks)) {
                expect(block.includes(`'${key}':`), `${loc} missing ${key}`).toBe(true);
            }
        }
    });
});
