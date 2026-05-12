import {Plugin, getFrontend} from "siyuan";
import "./index.scss";
import {createSidebarTerminal} from "./terminalDock";

const DOCK_TYPE = "dock_terminal";

/** 与 app/src/protyle/util/compatibility.ts 一致，用于拼接 Dock 图标 aria-label 中的快捷键说明 */
function isMac(): boolean {
    return navigator.platform.toUpperCase().indexOf("MAC") > -1;
}

function updateHotkeyTip(hotkey: string): string {
    if (!hotkey || isMac()) {
        return hotkey;
    }
    const keys: string[] = [];
    if ((hotkey.indexOf("⌘") > -1 || hotkey.indexOf("⌃") > -1)) {
        keys.push("Ctrl");
    }
    if (hotkey.indexOf("⇧") > -1) {
        keys.push("Shift");
    }
    if (hotkey.indexOf("⌥") > -1) {
        keys.push("Alt");
    }
    const lastKey = hotkey.replace(/[⌘⇧⌥⌃]/g, "");
    if (lastKey) {
        const map: Record<string, string> = {
            "⇥": "Tab",
            "⌫": "Backspace",
            "⌦": "Delete",
            "↩": "Enter",
        };
        keys.push(map[lastKey] || lastKey);
    }
    return keys.join("+");
}

function updateHotkeyAfterTip(hotkey: string, split = " "): string {
    if (hotkey) {
        return split + updateHotkeyTip(hotkey);
    }
    return "";
}

export default class PluginTerminal extends Plugin {

    private terminalDockApi?: {dispose: () => void; fit: () => void; bumpFontSize: (delta: number) => void};

    onload() {
        const fe = getFrontend();
        const isMobile = fe === "mobile" || fe === "browser-mobile";
        this.addDock({
            config: {
                position: "RightBottom",
                // height 为 0 表示随侧栏可用高度伸缩，固定数值会锁死 data-height，窗口拉高后终端不再变高
                size: {width: 320, height: 0},
                icon: "iconTerminal",
                title: this.i18n.dockTitle as string,
                hotkey: "",
            },
            data: {},
            type: DOCK_TYPE,
            init: (custom) => {
                const el = custom.element as HTMLElement;
                el.classList.add("fn__flex-column", "Terminal__panelRoot");
                if (isMobile) {
                    el.innerHTML = `<div class="toolbar toolbar--border toolbar--dark">
    <svg class="toolbar__icon"><use xlink:href="#iconTerminal"></use></svg>
        <div class="toolbar__text">${this.i18n.dockTitle}</div>
    </div>
    <div class="fn__flex-1 fn__flex-column Terminal__dock">
        <div class="fn__flex-1 Terminal__mount"></div>
    </div>`;
                } else {
                    const sy = window.siyuan;
                    const minAria = `${sy.languages.min}${updateHotkeyAfterTip(sy.config.keymap.general.closeTab.custom)}`;
                    const fontSmallerAria = sy.languages.zoomOut;
                    const fontLargerAria = sy.languages.zoomIn;
                    el.innerHTML = `<div class="fn__flex-1 fn__flex-column Terminal__dock">
    <div class="block__icons">
        <div class="block__logo">${this.i18n.dockTitle}</div>
        <span class="fn__flex-1 fn__space"></span>
        <span data-type="fontSmaller" class="block__icon ariaLabel" data-position="north" aria-label="${fontSmallerAria}"><svg><use xlink:href="#iconZoomOut"></use></svg></span><div class="fn__space"></div>
        <span data-type="fontLarger" class="block__icon ariaLabel" data-position="north" aria-label="${fontLargerAria}"><svg><use xlink:href="#iconZoomIn"></use></svg></span><div class="fn__space"></div>
        <span data-type="min" class="block__icon ariaLabel" data-position="north" aria-label="${minAria}"><svg><use xlink:href="#iconMin"></use></svg></span>
    </div>
    <div class="fn__flex-1 Terminal__mount"></div>
</div>`;
                }
                const mount = el.querySelector(".Terminal__mount") as HTMLElement;
                const canUsePty = getFrontend() === "desktop" && typeof (window as Window & {require?: unknown}).require === "function";
                this.terminalDockApi = createSidebarTerminal({
                    pluginName: this.name,
                    layoutRoot: el,
                    mount,
                    canUsePty,
                    i18n: {
                        unsupportedEnv: this.i18n.unsupportedEnv as string,
                        preparingPty: this.i18n.preparingPty as string,
                        ptyFailed: this.i18n.ptyFailed as string,
                    },
                });
                if (!isMobile) {
                    el.querySelector('[data-type="fontSmaller"]')?.addEventListener("click", () => {
                        this.terminalDockApi?.bumpFontSize(-1);
                    });
                    el.querySelector('[data-type="fontLarger"]')?.addEventListener("click", () => {
                        this.terminalDockApi?.bumpFontSize(1);
                    });
                }
            },
            resize: () => {
                this.terminalDockApi?.fit();
            },
            destroy: () => {
                this.terminalDockApi?.dispose();
                this.terminalDockApi = undefined;
            },
        });
    }

    onunload() {
        this.terminalDockApi?.dispose();
        this.terminalDockApi = undefined;
    }
}
