import {Terminal} from "@xterm/xterm";
import {FitAddon} from "@xterm/addon-fit";
import {Unicode11Addon} from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import {Constants, fetchPost, fetchSyncPost} from "siyuan";
import type {IDisposable, IPty, NodePtyModule} from "./nodePtyTypes";
import {getPluginTempRootDir, needsOnlineNodePtyInstall, resolveNodePtyRoot} from "./nodePtyResolver";
import {attachTerminalGpuRenderer, type TerminalGpuBackend} from "./terminalGpuRenderer";

export type {TerminalGpuBackend};

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
        isPublish?: boolean;
        config?: {
            readonly?: boolean;
            system?: {dataDir?: string; workspaceDir?: string};
            dataDir?: string;
            workspaceDir?: string;
            editor?: {
                fontFamily?: string;
                fontSize?: number;
                fontWeight?: number;
            };
        };
    };
};

/** 写入 data/storage/local.json，与主程序其它 local 键并列，避免与其它功能冲突 */
const TERMINAL_FONT_SIZE_STORAGE_KEY = "plugin-terminal-fontSize";

function clampTerminalFontSizePx(n: number): number {
    return Math.min(32, Math.max(8, Math.round(n)));
}

function parsePersistedTerminalFontSize(data: unknown): number | undefined {
    if (typeof data === "number" && Number.isFinite(data)) {
        return clampTerminalFontSizePx(data);
    }
    if (typeof data === "string") {
        const t = data.trim();
        if (t.length === 0) {
            return undefined;
        }
        const n = Number(t);
        if (Number.isFinite(n)) {
            return clampTerminalFontSizePx(n);
        }
    }
    return undefined;
}

/** 与 assets 注入的 `--b3-font-size-editor` 对齐，不依赖 config 对象字段是否已就绪 */
function parseEditorFontSizeFromCssVar(): number | undefined {
    if (typeof document === "undefined") {
        return undefined;
    }
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--b3-font-size-editor").trim();
    if (!raw) {
        return undefined;
    }
    const m = /^([\d.]+)\s*px$/i.exec(raw);
    if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) {
            return clampTerminalFontSizePx(n);
        }
    }
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) {
        return clampTerminalFontSizePx(n);
    }
    return undefined;
}

async function resolveInitialTerminalFontSizePx(): Promise<number> {
    try {
        const res = (await fetchSyncPost("/api/storage/getLocalStorageVal", {
            key: TERMINAL_FONT_SIZE_STORAGE_KEY,
        })) as {code?: number; data?: unknown};
        if (res && res.code === 0) {
            const parsed = parsePersistedTerminalFontSize(res.data);
            if (parsed !== undefined) {
                return parsed;
            }
        }
    } catch (e) {
        console.warn("[Terminal] 读取字号持久化失败", e);
    }
    return parseEditorFontSizeFromCssVar() ?? 11;
}

function persistTerminalFontSize(fontSize: number): void {
    const sy = (window as SiyuanWindow).siyuan;
    if (!sy || sy.config?.readonly || sy.isPublish) {
        return;
    }
    fetchPost("/api/storage/setLocalStorageVal", {
        app: Constants.SIYUAN_APPID,
        key: TERMINAL_FONT_SIZE_STORAGE_KEY,
        val: fontSize,
    });
}

/** 与 VS Code 在「未单独设置 terminal.integrated.fontFamily」时回退到 editor.fontFamily 的策略对齐 */
const FALLBACK_TERMINAL_FONT_FAMILY =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Microsoft YaHei UI"';

function isMacintoshHost(): boolean {
    return typeof navigator !== "undefined" && navigator.platform.toUpperCase().indexOf("MAC") > -1;
}

/**
 * 对齐 VS Code `TerminalFontMetrics.getFont`：优先思源 `editor.fontFamily`，再追加 `, monospace`；
 * macOS 再追加 `AppleBraille`（与 VS Code 一致，避免盲文格显示异常）。
 */
function resolveTerminalFontFromSiyuan(fontSize: number): {fontFamily: string; fontSize: number; fontWeight?: number} {
    const editor = (window as SiyuanWindow).siyuan?.config?.editor;
    const raw = editor?.fontFamily?.trim();
    const base = raw && raw.length > 0 ? raw : FALLBACK_TERMINAL_FONT_FAMILY;
    let fontFamily = `${base}, monospace`;
    if (isMacintoshHost()) {
        fontFamily += ", AppleBraille";
    }
    const w = editor?.fontWeight;
    const fontWeight = typeof w === "number" && w > 0 ? w : undefined;
    return {fontFamily, fontSize: clampTerminalFontSizePx(fontSize), fontWeight};
}

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

/** 供用户在 ~/.zshrc 等中判断「仅插件内嵌 PTY」；与 ZDOTDIR 方案可同时使用 */
const SIYUAN_TERMINAL_PLUGIN_ENV = "SIYUAN_TERMINAL_PLUGIN";

function shellPathLower(file: string): string {
    return file.toLowerCase();
}

function isZshShell(file: string): boolean {
    const p = shellPathLower(file);
    return p.endsWith("/zsh") || p.endsWith("\\zsh") || p.endsWith("zsh.exe");
}

function isBashShell(file: string): boolean {
    const p = shellPathLower(file);
    return p.endsWith("/bash") || p.endsWith("\\bash") || p.endsWith("bash.exe");
}

function isCmdExe(file: string): boolean {
    return shellPathLower(file).endsWith("cmd.exe");
}

function writeTextIfChanged(fsMod: typeof import("fs"), absPath: string, content: string): void {
    try {
        if (fsMod.readFileSync(absPath, "utf8") === content) {
            return;
        }
    } catch {
        // 文件不存在或不可读时重写
    }
    fsMod.writeFileSync(absPath, content, "utf8");
}

/**
 * 为插件内嵌 PTY 缩短提示符，不修改系统终端。
 * 生成文件落在 `<工作空间>/temp/plugin-<name>/terminal-profile/`（与 node-pty 缓存同级），不写 `data/plugins/<插件名>/` 安装目录。
 * - zsh：使用独立 ZDOTDIR，在 source 个人配置后用 precmd 覆盖 PROMPT（避免 Oh My Zsh 等把长提示符写回）
 * - bash：--rcfile 专用 rc，在加载个人配置后用 PROMPT_COMMAND 固定短 PS1
 * - cmd.exe：仅设置环境变量 PROMPT
 */
function prepareEmbedOnlyPrompt(
    nodeRequire: NodeJS.Require,
    dataDir: string,
    pluginName: string,
    shellFile: string,
    env: {[key: string]: string | undefined},
): {args: string[]} {
    env[SIYUAN_TERMINAL_PLUGIN_ENV] = "1";
    const pathMod = nodeRequire("path") as typeof import("path");
    const fsMod = nodeRequire("fs") as typeof import("fs");
    const osMod = nodeRequire("os") as typeof import("os");

    if (osMod.platform() === "win32") {
        if (isCmdExe(shellFile)) {
            env.PROMPT = "$G ";
        }
        return {args: []};
    }

    // 仅 zsh / bash 写入 terminal-profile；其它 Shell 仅用环境变量，避免留下空目录
    const profileRoot = pathMod.join(getPluginTempRootDir(dataDir, pluginName, nodeRequire), "terminal-profile");

    if (isZshShell(shellFile)) {
        fsMod.mkdirSync(profileRoot, {recursive: true});
        const zdot = pathMod.join(profileRoot, "zdot");
        fsMod.mkdirSync(zdot, {recursive: true});
        const zshenv = pathMod.join(zdot, ".zshenv");
        const zshenvBody = `# 仅用于思源 Terminal 插件内嵌 PTY。设置 ZDOTDIR 后 zsh 只自动读该目录下的 .zshenv，此处再加载用户主目录下的 .zshenv（不写、不改用户文件）。
[[ -r "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
`;
        writeTextIfChanged(fsMod, zshenv, zshenvBody);
        const zshrc = pathMod.join(zdot, ".zshrc");
        const body = `# 仅用于思源 Terminal 插件内嵌 PTY（ZDOTDIR），不修改用户主目录下的任何文件；以下仅为 source 读取并执行。
if [[ -r "$HOME/.zshrc" ]]; then
  source "$HOME/.zshrc"
fi
function _siyuanTerminalShortPrompt() {
  PROMPT='%F{cyan}%1~%f %# '
  RPROMPT=''
}
precmd_functions+=(_siyuanTerminalShortPrompt)
_siyuanTerminalShortPrompt
`;
        writeTextIfChanged(fsMod, zshrc, body);
        env.ZDOTDIR = zdot;
        return {args: []};
    }

    if (isBashShell(shellFile)) {
        fsMod.mkdirSync(profileRoot, {recursive: true});
        const bashRc = pathMod.join(profileRoot, "bash_plugin_rc");
        const body = `# 仅用于思源 Terminal 插件内嵌 PTY（bash --rcfile），不影响系统自带终端应用。
[[ -r /etc/bashrc ]] && source /etc/bashrc
[[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
_siyuan_terminal_ps1() { export PS1='\\W$ '; }
PROMPT_COMMAND="_siyuan_terminal_ps1\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
_siyuan_terminal_ps1
`;
        writeTextIfChanged(fsMod, bashRc, body);
        return {args: ["--rcfile", bashRc, "-i"]};
    }

    if (isZshShell(shellFile) === false && isBashShell(shellFile) === false) {
        env.PS1 = "\\W\\$ ";
    }
    return {args: []};
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

export async function createSidebarTerminal(options: CreateSidebarTerminalOptions): Promise<{
    dispose: () => void;
    fit: () => void;
    /** 按像素步进调整终端字号并 refit */
    bumpFontSize: (delta: number) => void;
    /** 当前 xterm 绘制后端：`webgl` | `canvas` | `dom`（WebGL 丢失上下文后会变为 `canvas`） */
    getRenderBackend: () => TerminalGpuBackend;
}> {
    const {pluginName, layoutRoot, mount, canUsePty, i18n} = options;
    mount.textContent = "";
    mount.classList.add("Terminal__root");

    const termContainer = document.createElement("div");
    termContainer.className = "Terminal__xterm";
    mount.append(termContainer);

    const initialFontSize = await resolveInitialTerminalFontSizePx();
    const tf = resolveTerminalFontFromSiyuan(initialFontSize);
    const term = new Terminal({
        /** Unicode11Addon 依赖 `terminal.unicode`（xterm 标记为 proposed API） */
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: tf.fontFamily,
        fontSize: tf.fontSize,
        ...(tf.fontWeight !== undefined ? {fontWeight: tf.fontWeight} : {}),
        /** 与 VS Code `DEFAULT_LETTER_SPACING` 一致；显式写出，避免嵌入环境继承非 0 的 letter-spacing */
        letterSpacing: 0,
        scrollback: 5000,
        theme: {...buildSiyuanXtermTheme()},
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);
    /** 与 VS Code 默认 `terminal.integrated.unicodeVersion: 11` 对齐（不启用此前的调试 fetch，避免影响启动） */
    try {
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = "11";
    } catch (err) {
        console.warn("[Terminal] Unicode11Addon:", err);
    }

    const gpuRenderer = attachTerminalGpuRenderer(term);

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
        const current = term.options.fontSize ?? 11;
        const next = Math.min(32, Math.max(8, Math.round(current + delta)));
        if (next === current) {
            return;
        }
        term.options.fontSize = next;
        persistTerminalFontSize(next);
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
        gpuRenderer.dispose();
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
    requestAnimationFrame(() => {
        fit();
        console.info("[Terminal] 已启动", {
            renderBackend: gpuRenderer.getBackend(),
            cols: term.cols,
            rows: term.rows,
            ptyEnabled: canUsePty && typeof getNodeRequire() === "function",
        });
    });

    if (!canUsePty) {
        term.writeln(i18n.unsupportedEnv);
        return {dispose, fit, bumpFontSize, getRenderBackend: () => gpuRenderer.getBackend()};
    }

    const nodeRequire = getNodeRequire();
    if (!nodeRequire) {
        term.writeln(i18n.unsupportedEnv);
        return {dispose, fit, bumpFontSize, getRenderBackend: () => gpuRenderer.getBackend()};
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
            const {file, args: pickArgs} = pickShell(nodeRequire);
            const cwd = pickCwd(nodeRequire);
            const env = cloneEnv(nodeRequire);
            const {args: promptArgs} = prepareEmbedOnlyPrompt(nodeRequire, dataDir, pluginName, file, env);
            const args = promptArgs.length > 0 ? promptArgs : pickArgs;

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

    return {dispose, fit, bumpFontSize, getRenderBackend: () => gpuRenderer.getBackend()};
}
