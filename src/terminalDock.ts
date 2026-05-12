import {Terminal} from "@xterm/xterm";
import {FitAddon} from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type {IDisposable, IPty, NodePtyModule} from "./nodePtyTypes";
import {needsOnlineNodePtyInstall, resolveNodePtyRoot} from "./nodePtyResolver";

/** 侧边栏终端：xterm.js 与 node-pty 字节流对接（仅桌面端启用 PTY） */
export interface SidebarTerminalI18n {
    unsupportedEnv: string;
    /** 首次从 registry 拉取 node-pty 时提示 */
    preparingPty: string;
    ptyFailed: string;
}

export interface CreateSidebarTerminalOptions {
    pluginName: string;
    /** 整块 Dock 面板根（Tab.panelElement），尺寸变化时触发 fit，避免只监听 mount 漏掉外层变高 */
    layoutRoot: HTMLElement;
    mount: HTMLElement;
    canUsePty: boolean;
    i18n: SidebarTerminalI18n;
}

function getNodeRequire(): NodeJS.Require | undefined {
    if (typeof window === "undefined") {
        return undefined;
    }
    const wr = (window as Window & {require?: NodeJS.Require}).require;
    return typeof wr === "function" ? wr : undefined;
}

type SiyuanWindow = Window & {
    siyuan?: {
        config?: {
            system?: {dataDir?: string; workspaceDir?: string};
            dataDir?: string;
            workspaceDir?: string;
        };
    };
};

/** 与内核写入插件目录的约定一致：{workspaceDataDir}/plugins/<name>（前端为 config.system.dataDir） */
function getWorkspaceDataDir(): string | undefined {
    const cfg = (window as SiyuanWindow).siyuan?.config;
    return cfg?.system?.dataDir || cfg?.dataDir;
}

function loadNodePtyModuleFromRoot(nodeRequire: NodeJS.Require, ptyRoot: string): NodePtyModule {
    return nodeRequire(ptyRoot) as NodePtyModule;
}

function pickShell(nodeRequire: NodeJS.Require): {file: string; args: string[]} {
    const osMod = nodeRequire("os") as typeof import("os");
    if (osMod.platform() === "win32") {
        const proc = nodeRequire("process") as NodeJS.Process;
        const comspec = proc.env.COMSPEC;
        return {file: comspec && comspec.length > 0 ? comspec : "C:\\Windows\\System32\\cmd.exe", args: []};
    }
    const proc = nodeRequire("process") as NodeJS.Process;
    const sh = proc.env.SHELL;
    return {file: sh && sh.length > 0 ? sh : "/bin/bash", args: []};
}

function pickCwd(nodeRequire: NodeJS.Require): string {
    const osMod = nodeRequire("os") as typeof import("os");
    const cfg = (window as SiyuanWindow).siyuan?.config;
    const dir = cfg?.system?.workspaceDir || cfg?.system?.dataDir || cfg?.workspaceDir || cfg?.dataDir;
    return dir && dir.length > 0 ? dir : osMod.homedir();
}

function cloneEnv(nodeRequire: NodeJS.Require): {[key: string]: string | undefined} {
    const proc = nodeRequire("process") as NodeJS.Process;
    return {...proc.env, TERM: "xterm-256color"};
}

/**
 * 从思源当前主题 CSS 变量生成 xterm 配色（随明亮 / 暗黑与主题包变化）。
 * 单次调用 getComputedStyle(document.documentElement)，其后再多次 getPropertyValue，避免反复取整棵计算样式。
 */
function buildSiyuanXtermTheme() {
    const rootStyle = getComputedStyle(document.documentElement);
    const css = (name: string, fallback: string): string => {
        const raw = rootStyle.getPropertyValue(name).trim();
        return raw || fallback;
    };

    const bg = css("--b3-theme-background", "#1e1e1e");
    const fg = css("--b3-theme-on-background", "#dadada");
    const surface = css("--b3-theme-surface", "#2c2c2c");
    const primary = css("--b3-theme-primary", "#3575f0");
    const primaryLight = css("--b3-theme-primary-light", "rgba(53, 117, 240, .72)");
    const error = css("--b3-theme-error", "#d23f31");
    const success = css("--b3-theme-success", "#65b84d");
    const secondary = css("--b3-theme-secondary", "#f3a92f");
    const onSurface = css("--b3-theme-on-surface", "#9aa0a6");
    const onSurfaceLight = css("--b3-theme-on-surface-light", "#bababa");
    const selectionBg = css("--b3-theme-primary-lightest", "rgba(53, 117, 240, .24)");
    const onPrimary = css("--b3-theme-on-primary", "#ffffff");

    return {
        background: bg,
        foreground: fg,
        cursor: primary,
        cursorAccent: onPrimary,
        selectionBackground: selectionBg,
        selectionInactiveBackground: selectionBg,
        black: surface,
        red: error,
        green: success,
        yellow: secondary,
        blue: primary,
        magenta: "#ab47bc",
        cyan: "#00838f",
        white: fg,
        brightBlack: onSurface,
        brightRed: error,
        brightGreen: success,
        brightYellow: secondary,
        brightBlue: primaryLight,
        brightMagenta: "#ce93d8",
        brightCyan: "#4dd0e1",
        brightWhite: onSurfaceLight,
    };
}

function bindTerminalThemeToSiyuan(term: Terminal, cleanups: Array<() => void>): void {
    const sync = () => {
        term.options.theme = {...buildSiyuanXtermTheme()};
    };
    sync();

    const root = document.documentElement;
    const mo = new MutationObserver(() => {
        sync();
    });
    mo.observe(root, {
        attributes: true,
        attributeFilter: ["data-theme-mode", "data-light-theme", "data-dark-theme"],
    });
    cleanups.push(() => {
        mo.disconnect();
    });

    const bindLink = (id: string) => {
        const link = document.getElementById(id) as HTMLLinkElement | null;
        if (!link) {
            return;
        }
        const handler = () => {
            sync();
        };
        link.addEventListener("load", handler);
        cleanups.push(() => {
            link.removeEventListener("load", handler);
        });
    };
    bindLink("themeStyle");
    bindLink("themeDefaultStyle");

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onOsTheme = () => {
        sync();
    };
    if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onOsTheme);
        cleanups.push(() => {
            mql.removeEventListener("change", onOsTheme);
        });
    } else {
        mql.addListener(onOsTheme);
        cleanups.push(() => {
            mql.removeListener(onOsTheme);
        });
    }
}

export function createSidebarTerminal(options: CreateSidebarTerminalOptions): {
    dispose: () => void;
    fit: () => void;
    /** 按像素步进调整终端字号并 refit */
    bumpFontSize: (delta: number) => void;
} {
    const {pluginName, layoutRoot, mount, canUsePty, i18n} = options;
    mount.textContent = "";
    mount.classList.add("Terminal__root");

    const termContainer = document.createElement("div");
    termContainer.className = "Terminal__xterm";
    mount.append(termContainer);

    const term = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        scrollback: 5000,
        theme: {...buildSiyuanXtermTheme()},
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);

    const themeCleanups: Array<() => void> = [];
    bindTerminalThemeToSiyuan(term, themeCleanups);

    let pty: IPty | undefined;
    const disposables: IDisposable[] = [];
    let resizeObserver: ResizeObserver | undefined;
    let windowResizeRaf = 0;
    let resizeObserverRaf = 0;
    let ptyInitCancelled = false;

    const fit = () => {
        try {
            fitAddon.fit();
        } catch {
            // 尺寸为 0 时 fit 可能失败，忽略即可
        }
        if (pty) {
            pty.resize(term.cols, term.rows);
        }
    };

    const bumpFontSize = (delta: number) => {
        const current = term.options.fontSize ?? 15;
        const next = Math.min(32, Math.max(8, Math.round(current + delta)));
        if (next === current) {
            return;
        }
        term.options.fontSize = next;
        fit();
    };

    const onWindowResize = () => {
        cancelAnimationFrame(windowResizeRaf);
        windowResizeRaf = requestAnimationFrame(() => {
            windowResizeRaf = 0;
            fit();
        });
    };

    const dispose = () => {
        ptyInitCancelled = true;
        window.removeEventListener("resize", onWindowResize);
        cancelAnimationFrame(windowResizeRaf);
        cancelAnimationFrame(resizeObserverRaf);
        windowResizeRaf = 0;
        resizeObserverRaf = 0;
        const pendingTheme = themeCleanups.slice();
        themeCleanups.length = 0;
        pendingTheme.forEach((fn) => {
            fn();
        });
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = undefined;
        }
        disposables.forEach((d) => d.dispose());
        disposables.length = 0;
        if (pty) {
            try {
                pty.kill();
            } catch {
                // 已退出时忽略
            }
            pty = undefined;
        }
        term.dispose();
    };

    resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(resizeObserverRaf);
        resizeObserverRaf = requestAnimationFrame(() => {
            resizeObserverRaf = 0;
            fit();
        });
    });
    resizeObserver.observe(layoutRoot);
    if (layoutRoot !== mount) {
        resizeObserver.observe(mount);
    }
    window.addEventListener("resize", onWindowResize);
    requestAnimationFrame(() => fit());

    if (!canUsePty) {
        term.writeln(i18n.unsupportedEnv);
        return {dispose, fit, bumpFontSize};
    }

    const nodeRequire = getNodeRequire();
    if (!nodeRequire) {
        term.writeln(i18n.unsupportedEnv);
        return {dispose, fit, bumpFontSize};
    }

    void (async () => {
        const dataDir = getWorkspaceDataDir();
        if (!dataDir) {
            if (!ptyInitCancelled) {
                term.writeln(i18n.ptyFailed.replace("${msg}", "siyuan.config.system.dataDir is missing"));
            }
            return;
        }

        try {
            if (needsOnlineNodePtyInstall(dataDir, pluginName, nodeRequire) && !ptyInitCancelled) {
                term.writeln(i18n.preparingPty);
            }
            const ptyRoot = await resolveNodePtyRoot(dataDir, pluginName, nodeRequire);
            if (ptyInitCancelled) {
                return;
            }
            const ptyMod = loadNodePtyModuleFromRoot(nodeRequire, ptyRoot);
            const {file, args} = pickShell(nodeRequire);
            const cwd = pickCwd(nodeRequire);
            const env = cloneEnv(nodeRequire);

            fitAddon.fit();
            pty = ptyMod.spawn(file, args, {
                name: "xterm-256color",
                cols: term.cols,
                rows: term.rows,
                cwd,
                env,
            });

            disposables.push(
                pty.onData((data: string) => {
                    term.write(data);
                }),
            );
            disposables.push(
                pty.onExit(() => {
                    term.writeln("\r\n\x1b[33m[exit]\x1b[0m");
                }),
            );

            term.onData((data) => {
                pty?.write(data);
            });
        } catch (e) {
            if (ptyInitCancelled) {
                return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            term.writeln(i18n.ptyFailed.replace("${msg}", msg));
        }
    })();

    return {dispose, fit, bumpFontSize};
}
