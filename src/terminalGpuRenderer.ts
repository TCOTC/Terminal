import {CanvasAddon} from "@xterm/addon-canvas";
import {WebglAddon} from "@xterm/addon-webgl";
import type {IDisposable, Terminal} from "@xterm/xterm";

/** 实际用于绘制的后端（不含 xterm 内部细节，仅作诊断用途） */
export type TerminalGpuBackend = "webgl" | "canvas" | "dom";

export interface TerminalGpuHandle {
    getBackend(): TerminalGpuBackend;
    dispose(): void;
}

/**
 * 在 `Terminal.open()` 之后调用：依次尝试 WebGL2、Canvas2D 替换默认的 DomRenderer。
 * 与常见「嵌入式终端」做法一致；失败时静默保留 DOM，不抛错打断插件加载。
 */
export function attachTerminalGpuRenderer(terminal: Terminal): TerminalGpuHandle {
    let backend: TerminalGpuBackend = "dom";
    let activeAddon: (WebglAddon | CanvasAddon) | null = null;
    let contextLossHook: IDisposable | null = null;

    const disposeActive = (): void => {
        if (contextLossHook) {
            try {
                contextLossHook.dispose();
            } catch {
                // 忽略
            }
            contextLossHook = null;
        }
        if (activeAddon) {
            try {
                activeAddon.dispose();
            } catch {
                // xterm 在部分环境下 dispose 链可能抛错，避免影响插件卸载
            }
            activeAddon = null;
        }
    };

    const tryMountCanvas = (): void => {
        disposeActive();
        try {
            const canvas = new CanvasAddon();
            terminal.loadAddon(canvas);
            activeAddon = canvas;
            backend = "canvas";
        } catch (err) {
            backend = "dom";
            console.warn("[Terminal] Canvas 渲染器不可用，使用内置 DOM 渲染。", err);
        }
    };

    const tryMountWebgl = (): void => {
        disposeActive();
        let webgl: WebglAddon;
        try {
            webgl = new WebglAddon(false);
        } catch (err) {
            console.warn("[Terminal] WebGL 渲染器构造失败，尝试 Canvas。", err);
            tryMountCanvas();
            return;
        }
        try {
            terminal.loadAddon(webgl);
            activeAddon = webgl;
            backend = "webgl";
            contextLossHook = webgl.onContextLoss(() => {
                contextLossHook?.dispose();
                contextLossHook = null;
                try {
                    webgl.dispose();
                } catch {
                    // 忽略
                }
                activeAddon = null;
                tryMountCanvas();
            });
        } catch (err) {
            console.warn("[Terminal] WebGL 渲染器挂载失败，尝试 Canvas。", err);
            try {
                webgl.dispose();
            } catch {
                // 忽略
            }
            tryMountCanvas();
        }
    };

    tryMountWebgl();

    return {
        getBackend(): TerminalGpuBackend {
            return backend;
        },
        dispose(): void {
            disposeActive();
        },
    };
}
