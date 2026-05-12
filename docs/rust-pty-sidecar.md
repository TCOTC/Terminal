# Rust 独立 PTY 侧车方案说明

本文档描述：在思源笔记桌面端插件中，用 **独立 Rust 可执行文件（sidecar）** 承担 **伪终端（PTY）** 能力的技术路线。用于与当前基于 **npm 按需缓存的 `node-pty`** 方案对照，便于评估迁移或并存。

阅读前建议先浏览 [development.md](./development.md) 中的「本机 Shell 与 PTY」与架构示意。

---

## 1. 文档目的

- 说明 **为何** 会出现「Rust 侧车」这一选项（与 Electron / Node ABI 的关系）。
- 给出 **推荐技术栈**、**进程边界**、**通信与协议设计要点**。
- 列出 **Windows / macOS / Linux** 与 **x64 / arm64** 下的 **构建、分发、体积与安全** 注意事项。
- 与 **`node-pty`** 在维护成本与体积上做 **对照**，便于决策。

本文 **不** 包含可直接复制运行的完整生产代码；落地时需结合思源插件 API、Electron 主进程 / preload 能力与具体安全策略实现。

---

## 2. 问题背景：谁在绑定 Electron 版本？

- **`node-pty`** 以 **Node 原生扩展（`.node`）** 形式加载进 **Electron 自带的 Node** 进程。
- 该二进制与 **当前 Electron 所嵌入的 Node ABI** 强相关；思源升级内置 Electron 后，若官方 `node-pty` 预编译尚未覆盖新的 `modules`，终端可能不可用，需 **等待上游发版** 或在本插件中 **调整锁定的拉取版本**（见 [node-pty-prebuild-cache.md](./node-pty-prebuild-cache.md)）。

**Rust sidecar** 的思路是：PTY 逻辑跑在 **普通操作系统进程** 里，通过 **stdin/stdout、Socket 或命名管道** 与插件交换数据。该可执行文件 **不作为** Node 原生模块被 `require`，因此 **通常不** 随 Electron 小版本升级而必须重编 PTY 层（仍需按 **OS + CPU 架构** 分发二进制，见后文）。

---

## 3. 方案概述

### 3.1 架构

```
用户输入 → xterm.js → 插件（JS）──IPC──→ Rust sidecar → PTY → shell
                ↑                              ↓
                └──────── 字节流 / 控制帧 ──────┘
```

- **xterm.js**：仍负责渲染与 VT 序列；与现方案一致。
- **插件**：负责 Dock、主题、将键盘/粘贴转为 **写 PTY 的字节流**，以及处理 **窗口尺寸变化（cols/rows）** 等。
- **Rust sidecar**：唯一职责是 **创建 PTY、spawn shell、转发 I/O、上报子进程退出**，尽量保持 **无界面、无业务**。

### 3.2 与 `node-pty` 的本质差异

| 维度 | `node-pty` | Rust sidecar |
|------|------------|----------------|
| 与 Electron Node ABI | 强相关 | 一般不相关 |
| 分发单元 | `.node`（常按 Electron + 平台矩阵） | 各平台 **可执行文件** |
| 协议 | 同进程 API 调用 | 需 **自定义 IPC 协议** |
| 工程复杂度 | 较低（成熟 npm 包） | 较高（双语言 + 打包 + 协议） |

---

## 4. 推荐技术栈（Rust 侧）

以下为社区中常用于「跨平台 PTY + 子进程」的组合，可按团队熟悉度裁剪。

### 4.1 PTY 与子进程

- **[`portable-pty`](https://crates.io/crates/portable-pty)**（Wez 等维护的跨平台抽象）  
  - **Unix（macOS / Linux）**：基于 POSIX 伪终端常见路径。  
  - **Windows**：基于 **ConPTY**（需 Windows 10 1809 及以后等环境；与 `node-pty` 在 Windows 上的现代路径一致）。  
  - 适合作为 sidecar 的 **PTY 创建、尺寸调整、读写 master 端** 的核心依赖。

### 4.2 异步与并发（可选）

- 若协议采用 **多路复用**（单连接上交替读写控制帧与原始字节），可使用 **`tokio`** + 非阻塞 I/O；  
- 若采用 **极简阻塞模型**（例如专用 pipe 分信道），也可在少量线程内用 **阻塞 read/write**，降低依赖面。

### 4.3 序列化与 CLI

- 控制面（resize、spawn 参数、退出码）可用 **`serde` + `serde_json`** 或 **长度前缀 + MessagePack** 等；数据面仍以 **原始字节** 为主，避免对 shell 输出做无意义编解码。
- 进程参数（shell 路径、`cwd`、`env`）可通过 **命令行参数**、**首包配置 JSON** 或 **环境变量** 注入；需统一文档并做 **输入校验**，防止命令注入（见第 9 节）。

---

## 5. IPC 与协议设计要点

### 5.1 传输载体

常见三种（可组合）：

1. **stdio**：父进程 `spawn` 后，**stdin/stdout** 传帧；实现简单，适合单会话。  
2. **Unix domain socket / 命名管道（Windows）**：适合双向流、后续多会话扩展。  
3. **TCP 回环（127.0.0.1）**：调试方便，需注意 **防火墙与端口占用**，生产环境慎用未鉴权监听。

思源插件侧通常通过 **`child_process.spawn`** 拉起 sidecar，**stdio 方案**与现有 Node 生态结合成本最低。

### 5.2 建议划分的信道

至少区分：

- **终端数据**：与 xterm 直连的 **原始字节**（含 ANSI 序列），应 **零拷贝语义**（逻辑上不对内容做 UTF-8 强制解析，除非你做明确转码策略）。  
- **控制面**：**窗口大小**（`cols` / `rows`）、**心跳**、**子进程退出码 / 信号** 等。

实现上可采用：

- **单流多路复用**：每一帧 `type + length + payload`，`payload` 为 JSON 或原始 bytes；  
- **双流**：fd0 仅 raw PTY，fd3 控制 JSON（需在 spawn 时 `stdio` 配置额外 pipe）。

### 5.3 生命周期

- 插件卸载或 Dock 关闭时，应 **关闭 IPC** 并向子进程组发送 **SIGTERM**（Unix）或 **TerminateProcess** 树（Windows），避免孤儿 shell。  
- sidecar 应处理 **stdin 关闭** 即退出并清理 PTY。

### 5.4 与 xterm 的对接关系

与当前 `node-pty` 方案相同：**xterm 只认字节流**；从 sidecar 读到的数据应 **原样** `write` 进 xterm；用户输入同理写入「写 PTY」信道。resize 时由插件把 **列行数** 发到控制面，Rust 调用 PTY 尺寸 API。

---

## 6. Electron / 思源插件侧注意点

- **拉起路径**：sidecar 建议放在插件目录下固定相对路径，例如 `bin/pty-sidecar-<platform>-<arch>`，启动前 **`fs.existsSync` 校验** 并做好 **降级提示**（缺二进制时说明平台不支持或未打包）。  
- **`cwd` 与 `env`**：与终端预期一致时，应允许配置工作目录与环境变量；敏感环境变量需文档说明。  
- **沙箱与 `child_process`**：以思源 **当前桌面端插件是否允许在对应上下文 `spawn`** 为准；若仅 preload 可用，则需与官方文档对齐，**不可臆测**。  
- **并发**：多标签多会话时，是 **多进程**（每会话一个 sidecar）还是 **单 sidecar 多会话**，决定协议复杂度；第一版通常 **一会话一进程** 最简单。

---

## 7. 构建与目标平台矩阵

### 7.1 建议覆盖的三元组（示例）

| 用户环境 | Rust `target` 示例 |
|----------|---------------------|
| Windows x64 | `x86_64-pc-windows-msvc` |
| Windows ARM64 | `aarch64-pc-windows-msvc`（按需） |
| macOS Intel | `x86_64-apple-darwin` |
| macOS Apple Silicon | `aarch64-apple-darwin` |
| Linux x64（glibc 常见发行版） | `x86_64-unknown-linux-gnu` |
| Linux ARM64 服务器 / 设备 | `aarch64-unknown-linux-gnu`（按需） |

实际是否提供 **Windows ARM64**、**Linux ARM64** 取决于用户画像与 CI 成本。

### 7.2 发布产物形态

- **推荐**：集市或发布页 **按平台分包**，每个 zip 只含 **当前 OS 所需的一个或两个架构**（如 macOS 可同时含 x64 与 arm64 的 **fat 分发策略**：运行时选择路径，或分别打两个包）。  
- **不推荐**：单包内含 **全 OS 全架构** 全部二进制，下载体积会 **线性膨胀**。

### 7.3 Linux：glibc 与 musl

- **`x86_64-unknown-linux-gnu`** 链到 **glibc**；在 **Alpine（musl）** 等环境可能无法运行。  
- 若有需求，可额外提供 **`x86_64-unknown-linux-musl`** 等 **静态或 musl** 构建，或在文档中 **声明仅支持 glibc 发行版**。  
- 这与 `node-pty` 在 Linux 上遇到的问题类型类似，但 sidecar 由你完全控制链接方式。

### 7.4 二进制体积优化（Rust）

- Release 默认 **`strip` 符号**、开启 **LTO** 可显著减小体积。  
- 在「真 PTY + 三端」前提下，**精心裁剪依赖** 的 Rust sidecar 常与 **`node-pty` 单个 `.node` 同量级或略大**；明显膨胀时检查是否误引大型依赖。

---

## 8. 打包进思源插件的目录建议

示例（仅说明结构，非强制命名）：

```text
data/plugins/Terminal/
  index.js
  plugin.json
  bin/
    pty-sidecar-darwin-x64
    pty-sidecar-darwin-arm64
    pty-sidecar-linux-x64
    pty-sidecar-win32-x64.exe
```

插件启动时根据 `process.platform` 与 `process.arch` **选择对应文件名**；找不到则给出 **可读错误**（中英提示）。

若继续使用 webpack 将 `node_modules` 打入 zip，需注意：**sidecar 必须是「原样复制」的二进制**，不要被 bundler 改写；通常在构建脚本中用 **`copy-webpack-plugin` 或独立 `cp` 步骤** 复制 `bin/`。

---

## 9. 安全与 macOS 分发

### 9.1 命令执行风险

终端类能力与 **`node-pty` 方案同等危险**：可执行本机任意命令。sidecar 额外需防范：

- **配置注入**：通过环境变量、JSON 首包传入的 shell 路径、参数若来自 **不可信内容**，可能导致 **命令执行漏洞**；应对 **白名单 shell**、**禁止换行与元字符** 等策略按产品要求设计。  
- **路径劫持**：优先使用 **绝对路径** 解析 sidecar，避免 `PATH` 劫持。

### 9.2 macOS 代码签名与公证

- 未签名或仅 ad-hoc 签名的二进制，在用户机器上可能触发 **隔离（Gatekeeper）** 或 **无法打开**。  
- 若面向广泛用户分发，需规划 **Apple 开发者证书签名** 与 **公证（notarization）**；这与思源主应用签名策略独立，**插件自带二进制** 的合规成本通常 **高于** 仅分发 `.node`（仍可能需签名，但侧车「独立可执行文件」在 macOS 上往往更敏感）。  
- 具体流程以 Apple 当前文档为准，本文不展开操作步骤。

### 9.3 Windows SmartScreen

- 未签名的 `.exe` 可能触发 SmartScreen；长期分发建议 **Authenticode 签名**。

---

## 10. 与 `node-pty` 的对比小结

| 项目 | `node-pty` | Rust sidecar |
|------|------------|----------------|
| Electron 升级 | 常需 **按 Electron 重建** | PTY 层 **通常不需** 随 Electron 变 |
| 协议与工程 | **低** | **高**（自研 IPC + 双栈维护） |
| 用户下载体积（单平台单架构） | **通常较小** | 依优化程度，**常略大或相近** |
| 全平台 fat 包 | 多个 `.node` 相加，**仍相对可控** | 多个可执行文件，**易明显变大** |
| macOS 分发合规 | 需关注 | **可执行文件** 往往 **更敏感** |
| 团队技能 | Node 为主 | Node + **Rust 与交叉编译** |

---

## 11. 何时优先考虑 Rust sidecar

- 思源 **频繁升级 Electron**，且 **`node-pty` 重建与多版本矩阵** 维护成本已高于接受侧车复杂度。  
- 希望 **PTY 实现与 Node 版本完全解耦**，由 **固定 ABI 的操作系统接口** 单独演进。  
- 已有 **Rust 工具链与 CI**，能稳定产出 **多 target** 产物。

若团队以 Node 为主、发版节奏与思源 Electron 版本 **可对齐**，**按需拉取官方预编译的 `node-pty`** 往往仍是 **综合成本更低** 的默认选项。

---

## 12. 参考链接

- [portable-pty - crates.io](https://crates.io/crates/portable-pty)  
- [xterm.js](https://github.com/xtermjs/xterm.js)  
- [node-pty](https://github.com/microsoft/node-pty)  
- 本仓库开发说明：[development.md](./development.md)

---

## 13. 文档维护

若本插件 **实际采用** Rust sidecar（完全替代或与 `node-pty` 并存），请同步：

- 更新 [development.md](./development.md) 中「本机 Shell 与 PTY」与架构图；  
- 在本节记录 **实际 crate 版本、协议版本号、支持的平台矩阵与下载分包策略**。
