# 开发说明（技术选型）

本文档记录本插件在实现「思源笔记侧边栏终端」时的技术选型，便于后续开发与协作对齐。

## 目标与范围

- **功能**：在思源笔记 **桌面端** 侧边栏（Dock）中嵌入可用的交互式终端。
- **运行环境**：与 `plugin.json` 一致，面向 **desktop** 前端，后端平台为 `darwin` / `linux` / `windows`。
- **能力前提**：插件侧可 `require('electron')` 与 Node 内置模块，用于与系统 shell 及伪终端对接。

## 工作区与思源主仓参考

- **做法**：在 Cursor / VS Code 等编辑器中，将 **本插件仓库** 与 **思源笔记官方源码仓库** 置于同一多根工作区（multi-root workspace）内，便于跳转与全文检索。
- **用途**：实现或排查插件相关行为时，可对照主仓中 **插件加载与沙箱策略、桌面端 Electron 集成、前端 API** 等实现；具体路径因本机 clone 位置而异，不在此写死。
- **注意**：主仓仅作阅读参考；本插件仍以思源对外文档与稳定 API 为准，避免依赖未公开或易变的内部细节。

## 终端 UI：xterm.js

- **选型**：使用 [**@xterm/xterm**](https://github.com/xtermjs/xterm.js) 作为终端模拟与渲染层（包名以官方当前发布为准，历史上曾用 `xterm`）。
- **理由**：生态与文档成熟，VS Code 等主流产品采用；Unicode / IME、常用 VT 序列与插件（如 `fit`、`webgl` 等）支持完善，适合作为第一版默认方案。
- **曾对比的其它方向**（未采用，仅作记录）：如基于 WASM 的 **ghostty-web**、轻量 DOM 方案的 **wterm**、偏 WebGL / Worker 的 **react-term** 等；若后续有体积、渲染或兼容性专项需求，可再评估替换或并存。

## 本机 Shell 与 PTY

- **方向**：在具备 Node 的前提下，使用 **`node-pty`** 创建伪终端，挂载用户默认 shell（如 bash / zsh），与 xterm 的 **标准输入输出字节流** 对接。
- **注意**：`node-pty` 为**原生模块**，需与思源当前内置的 **Electron / Node ABI** 匹配；发版或升级思源版本时，需按官方或社区惯例做 **rebuild** 或按目标 Electron 版本编译，避免加载失败。

## 架构关系（简述）

```
用户键盘 / 粘贴 → xterm.js → 字节流 → node-pty → shell
shell 输出 → node-pty → 字节流 → xterm.js → 屏幕
```

思源插件 API 负责 Dock 挂载、生命周期与样式主题；终端栈不替代思源的数据同步能力，仅在本机进程内执行命令。

## 文档维护

选型或关键依赖（Electron 版本、xterm 大版本、PTY 方案）变更时，请同步更新本节对应段落。

## 开发与发版

- **安装依赖**：在插件目录执行 `pnpm install`。
- **原生模块**：`node-pty` 需与思源内置 **Electron** 的 ABI 一致。请以思源主仓 [app/package.json](https://github.com/siyuan-note/siyuan/blob/master/app/package.json) 中的 `electron` 版本为准，在插件目录执行 `pnpm run rebuild-native`（内部为 `electron-rebuild -f -w node-pty`）。升级思源后若终端无法加载，应重新核对 Electron 版本并再次 rebuild。
- **发版产物**：生产构建会将 `node_modules/node-pty` 复制到 `dist/node_modules/node-pty` 并打入 `package.zip`，解压到工作空间 `data/plugins/<插件名>/` 后应与 `index.js` 同级提供 `node_modules`，无需在目标环境再执行 `pnpm install` 即可加载 PTY（体积含各平台预编译文件，属预期现象）。
- **安全提示**：终端可执行本机任意 shell 命令，请仅从可信来源安装本插件。
