import {Plugin, getFrontend} from "siyuan";
import "./index.scss";
import {dockSidebarTerminal} from "./terminalDock";

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
    onload() {
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
                const sy = window.siyuan;
                const minAria = `${sy.languages.min}${updateHotkeyAfterTip(sy.config.keymap.general.closeTab.custom)}`;
                const fontSmallerAria = sy.languages.zoomOut;
                const fontLargerAria = sy.languages.zoomIn;
                const closeTerminal = this.i18n.closeTerminal as string;
                const openNewTerminal = this.i18n.openNewTerminal as string;
                el.innerHTML = `<div class="fn__flex-1 fn__flex-column Terminal__dock">
    <div class="block__icons">
        <div class="block__logo">${this.i18n.dockTitle}</div>
        <span class="fn__flex-1 fn__space"></span>
        <span data-type="closeTerminal" class="block__icon ariaLabel" data-position="north" aria-label="${closeTerminal}"><svg><use xlink:href="#iconClose"></use></svg></span><div class="fn__space"></div>
        <span data-type="openNewTerminal" class="block__icon ariaLabel" data-position="north" aria-label="${openNewTerminal}"><svg><use xlink:href="#iconAdd"></use></svg></span><div class="fn__space"></div>
        <span data-type="fontSmaller" class="block__icon ariaLabel" data-position="north" aria-label="${fontSmallerAria}"><svg><use xlink:href="#iconZoomOut"></use></svg></span><div class="fn__space"></div>
        <span data-type="fontLarger" class="block__icon ariaLabel" data-position="north" aria-label="${fontLargerAria}"><svg><use xlink:href="#iconZoomIn"></use></svg></span><div class="fn__space"></div>
        <span data-type="min" class="block__icon ariaLabel" data-position="north" aria-label="${minAria}"><svg><use xlink:href="#iconMin"></use></svg></span>
    </div>
    <div class="fn__flex-1 fn__flex-column Terminal__body">
        <div class="fn__flex-1 Terminal__mount"></div>
        <div class="Terminal__empty fn__none">
            <button type="button" class="b3-button b3-button--outline Terminal__emptyOpen" aria-label="${openNewTerminal}">${openNewTerminal}</button>
        </div>
    </div>
</div>`;
                const mount = el.querySelector(".Terminal__mount") as HTMLElement;
                const emptyState = el.querySelector(".Terminal__empty") as HTMLElement;
                const canUsePty = getFrontend() === "desktop" && typeof (window as Window & {require?: unknown}).require === "function";
                const sidebarI18n = {
                    unsupportedEnv: this.i18n.unsupportedEnv as string,
                    preparingPty: this.i18n.preparingPty as string,
                    ptyFailed: this.i18n.ptyFailed as string,
                };
                const hideTerminalEmptyState = () => {
                    emptyState.classList.add("fn__none");
                };
                const showTerminalEmptyState = () => {
                    emptyState.classList.remove("fn__none");
                };
                const attachSidebarTerminal = () => {
                    hideTerminalEmptyState();
                    dockSidebarTerminal.attach({
                        pluginName: this.name,
                        layoutRoot: el,
                        mount,
                        canUsePty,
                        i18n: sidebarI18n,
                    });
                };
                const openNewTerminalSession = () => {
                    dockSidebarTerminal.disposePermanent();
                    mount.replaceChildren();
                    attachSidebarTerminal();
                };
                attachSidebarTerminal();
                el.querySelector('[data-type="fontSmaller"]')?.addEventListener("click", () => {
                    dockSidebarTerminal.bumpFontSize(-1);
                });
                el.querySelector('[data-type="fontLarger"]')?.addEventListener("click", () => {
                    dockSidebarTerminal.bumpFontSize(1);
                });
                el.querySelector('[data-type="closeTerminal"]')?.addEventListener("click", () => {
                    dockSidebarTerminal.disposePermanent();
                    mount.replaceChildren();
                    showTerminalEmptyState();
                });
                el.querySelector('[data-type="openNewTerminal"]')?.addEventListener("click", () => {
                    openNewTerminalSession();
                });
                emptyState.querySelector(".Terminal__emptyOpen")?.addEventListener("click", () => {
                    openNewTerminalSession();
                });
            },
            resize: () => {
                dockSidebarTerminal.fit();
            },
            /** `removeTab` 会先 `panelElement.remove()` 再调 `destroy`；整棵子树仍在内存中，此处把 xterm 迁出以便新 `init` 再挂上 */
            destroy: () => dockSidebarTerminal.detach(),
        });
    }

    onunload() {
        dockSidebarTerminal.disposePermanent();
    }
}
