# node-pty 预编译按需缓存方案（已实现）

本文档描述 **通过 npm registry 官方 `node-pty` tarball** 按需解压到工作空间 **`temp/`** 的 **`node-pty` 加载** 方案；发版与开发说明见 [development.md](./development.md)。历史上「随包复制 `node_modules/node-pty`」路线 **已由本实现替代**。

---

## 1. 背景与动机

### 1.1 问题

- **`node-pty`** 为原生模块，须与 **当前 Electron 进程的 Node ABI**（`process.versions.modules`）及 **操作系统 / 架构** 匹配。
- 将 **`node_modules` 整树打入 `data/plugins/<插件名>/`** 会增大 **思源数据仓库** 体积与文件数，且 **`/plugins/` 路径会参与同步语义**（主仓 `kernel/model/repository.go` 对 `/plugins/` 的变更处理），不利于云端同步与多设备场景。
- 跨设备同步 **错误平台的 `.node`** 会导致终端直接不可用。

### 1.2 目标

- **插件包**：以 **JS / 资源** 为主，**不**在 `data/` 下携带大体积原生依赖树；或仅带 **极小 stub**。
- **原生文件**：在 **首次需要时**（或 ABI 变化后）下载或抽取，落到 **工作空间 `temp/` 下自建子目录**（与 `data/` 平级，**不进入**以 `DataDir` 为根的同步树），见下文路径约定。
- **生态复用**：仅使用 **npm registry 官方发布的 `node-pty` tarball** 中的 **`prebuilds/`**（及 Windows 下与官方 `post-install` 等价的文件布局），不引入第二套自建下载源。

### 1.3 非目标

- 不讨论 **Rust sidecar**，见 [rust-pty-sidecar.md](./rust-pty-sidecar.md)。
- 不承诺 **零网络**：首次或升级后仍可能需要 **HTTPS 拉取**（仅 **npm registry**）。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ 思源桌面端 · 插件 JS（webpack 产出）                          │
│  - 启动 / 打开终端前：resolveNativeModule()                   │
│  - 命中缓存 → require(缓存根下的 node-pty 入口)              │
│  - 未命中 → 下载/解压 → 写缓存 → 再 require                    │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
                     npm registry
                   node-pty@锁定版本
              官方 tgz → 解压到 temp → require
```

**运行时依赖**：`https` / `crypto`（校验）、**系统 `tar` 可执行文件**（解压 `.tgz`，与 Node 自带 `child_process.spawnSync` 调用）、`fs`、`path`、`require`（或 `createRequire`）。未使用 npm `pacote` / Node 版 `tar` 库，以控制打包体积与 webpack 对 Node 内置模块的解析成本。

---

## 3. 工作空间路径约定

思源内核中（参见主仓 `kernel/util/working.go`）：

- **`DataDir`**：`WorkspaceDir/data`（同步仓库根，**含** `plugins/`）。
- **`TempDir`**：`WorkspaceDir/temp`（与 `data/` **同级**）。

### 3.1 缓存根目录（建议）

在 **`TempDir`** 下使用 **插件专用**、且 **不在思源已知清理列表中的子路径**，例如：

```text
<WorkspaceDir>/temp/plugin-Terminal/
```

目录名建议为 **`plugin-` + `plugin.json` 的 `name` 字段**（本插件为 **Terminal** → **`plugin-Terminal`**），避免多插件冲突。

### 3.2 禁止或慎用子路径

以下目录在思源逻辑中可能被 **`RemoveAll` 或频繁清理**（包括但不限于 `temp/os`、`temp/repo`、`temp/export`、`temp/import`、`temp/convert`、`temp/bazaar` 等，见主仓 `kernel/model/conf.go`、`kernel/util/working.go`）。**不得**将持久缓存放在这些固定名下。

### 3.3 缓存分桶键（目录名或一级子目录）

实现为 **`<platform>-<arch>` / `<NODE_PTY_RESOLVED_VERSION>`**（位于 `plugin-<name>/` 下），与 **本机平台** 及 **锁定的 node-pty 版本** 对齐；**不包含** `process.versions.modules` 或 Electron 发行号。插件 bump **`NODE_PTY_RESOLVED_VERSION`** 会自动使用新子目录。**注意**：思源升级若 **`modules`（ABI）变化** 而锁定版本未 bump，缓存路径不变，可能沿用不兼容二进制，应 **删除** `temp/plugin-<name>/<plat>/<ver>/` 或 bump 版本后重拉。

```text
<缓存根>/<platform>-<arch>/<node-pty-version>/
```

示例（仅说明形态）：

```text
.../temp/plugin-Terminal/darwin-arm64/1.1.0/
```

- **`platform` / `arch`**：`process.platform`、`process.arch`，目录名为 **`darwin-arm64`** 等形式。
- **`<node-pty-version>`**：插件内常量 **`NODE_PTY_RESOLVED_VERSION`**（经路径片段消毒），与拉取的 npm 包版本一致。

**命中规则**：若该目录下已存在 **校验通过** 的完整原生布局（含 `node-pty/package.json`），则 **跳过下载**。

**旧目录**：bump **`NODE_PTY_RESOLVED_VERSION`** 后，`<plat>/` 下可能留下 **旧版本号子目录**，可择机手动删除以省空间。

---

## 4. 插件包内应携带什么（最小集）

仅拉 **`.node` + Windows 附属文件** 往往不够：`node-pty` 的 **JS 入口与 `package.json`** 仍负责 **定位 binding**。建议二选一（实现时择一写死）：

### 方案 A：包内带「无原生或占位」的 node-pty JS 树（推荐）

- 在 **构建产物** 中复制 **`node_modules/node-pty` 的 `lib/`、`package.json`、`typings`（若需要）** 等到 `dist/vendor/node-pty/`（路径自定），**不复制** `build/`、`prebuilds/` 或仅复制空结构。
- 首次解压/下载的 **原生文件**，落到 **上述「缓存分桶」目录**，并通过 **环境变量或运行时 patch** 使 `node-pty` 的加载逻辑指向该目录（具体 hook 点需对照 **锁定版本** 的 `node-pty` 源码中 binding 解析方式；若上游支持 **`NODE_BINDINGS`** 或从 `prebuilds` 直载，应优先用 **公开 API**，避免硬改 `node_modules`）。

### 方案 B：将官方 `node-pty` 整包解压到缓存桶

- 从 npm tgz 解压 **整个 `package/`** 到缓存桶，再 **删除其它平台 prebuilds** 以省空间（可选）。  
- **`require`** 指向该目录。包体积与解压时间略大，但 **与官方布局 100% 一致**，对接成本最低。

**锁定版本**：插件内常量 **`NODE_PTY_RESOLVED_VERSION`**（与 `package.json` 中声明一致），所有拉取均使用该版本，避免漂移。

---

## 5. 拉取策略：仅 npm registry 官方 tarball

1. 解析 tarball URL：  
   `GET https://registry.npmjs.org/node-pty/<version>` → JSON 中 `dist.tarball`（或使用 **`pacote`** 等 npm 生态库封装，减少手写解析）。
2. **`HEAD` 或 `GET`** 下载 tgz（建议 **流式** 写入临时文件，避免整包进内存）。
3. **仅解压**与当前 **`platform` / `arch` / `modules`** 匹配的 **`prebuilds/`** 子树（以及 Windows 下 **`third_party/conpty`** 等 **`post-install` 脚本会拷贝的依赖**，须对照 **该版本** `scripts/post-install.js` 与目录结构，保证与「从 npm install 装出来」一致）。
4. 将解压结果 **merge** 到 **缓存分桶目录** 中 **与 `require` 一致的相对布局**。

**风险与边界**：官方包内 **`prebuilds` 是否包含当前思源 Electron 的 `modules`** 需 **发版前矩阵核对**。若 **npm 包中不存在对应预编译**，本方案 **不提供第二下载源**；此时只能 **提示用户**（升级思源 / 在本插件中调整锁定的 `node-pty` 版本常量等），或在 **产品层面** 声明支持的思源版本范围。

### 5.1 开发环境

- 本插件 **不** 在仓库安装 `node-pty`；开发与发版均依赖 **首次联网** 拉取（命中 `temp` 缓存后同机可离线）。

---

## 6. 校验、安全与隐私

- **传输**：仅 **HTTPS**；可选 **SPDX 锁定 registry 镜像** 时须在文档中说明风险。
- **完整性**：对下载的 **官方 tgz** 做校验，优先使用 registry 元数据中的 **`integrity`**（`sha512` 等，与 **`pacote`** 行为一致）。
- **Supply chain**：registry 主机与 **锁定版本号** 写死在代码或只读配置中；若支持可配置镜像，须在文档中说明 **信任边界**。
- **隐私**：缓存目录仅本机工作空间，**不**应记入笔记内容；若未来思源提供 **「插件专用、明确不同步」** 的官方 API，可再评估迁移缓存根。

---

## 7. 生命周期

| 事件 | 行为 |
|------|------|
| 打开终端 | `resolveNativeModule()`，命中缓存则直接加载。 |
| `modules`（ABI）变化而 **`NODE_PTY_RESOLVED_VERSION` 未 bump** | 路径 **不变**，可能误用旧缓存；应 **删除** `temp/plugin-<name>/<plat>/<ver>/` 或 bump 锁定版本后重拉。 |
| 插件更新（`NODE_PTY_RESOLVED_VERSION` bump） | **新子目录**（路径含新版本号）；**自动**拉取新包。旧版本子目录可择机手动删。 |
| 用户清空 `temp` | 下次打开 **自动重新拉取**（体验上可提示「正在准备终端组件」）。 |

---

## 8. 错误处理与 UX

- **网络失败 / 校验失败**：明确文案（中 / 英），提示检查网络、代理、企业防火墙；**不要**静默失败。
- **ABI 无可用预编译**（官方 tgz 中无匹配 `modules`）：提示 **当前思源版本与所选 `node-pty` 版本组合不受支持**，引导 **升级思源**、**等待插件更新（换 `NODE_PTY_RESOLVED_VERSION`）**；不承诺离线自动解决。
- **磁盘满 / 无写权限**：捕获 `ENOSPC` / `EACCES`，提示更换工作空间或权限。

---

## 9. 实现阶段建议（里程碑）

1. **调研**：锁定 `node-pty` 版本，本地 `pnpm pack node-pty@x.y.z` 或读 npm 包树，列出 **`prebuilds` 下与 Electron 相关的目录命名** 及 **Windows 额外文件清单**。  
2. **PoC**：仅 **darwin-arm64 + 当前思源 Electron**，实现 **第 5 节 tarball 解压 + require + 打开 shell 一行**。  
3. **路径**：接入 **`TempDir`** 解析（通过思源插件 API 获取 **工作空间根** 再拼接 `temp/plugin-Terminal/...`，避免写死磁盘绝对路径）。  
4. **矩阵**：补齐 **win32 / linux**，并对照 **思源各发行线 Electron** 核对 **npm 包内是否含对应 `modules`**，形成 **支持矩阵文档**。  
5. **构建**：webpack 改为 **不复制** `node_modules/node-pty` 到 `data` 下产物；或复制 **最小 JS 树**（方案 A）。  
6. **文档与用户说明**：在 README 中说明 **首次需联网**、**仅使用 npm registry**、**缓存位置**、**同步行为**、**不支持组合的提示文案**。

---

## 10. 待决问题（实现前需拍板）

- **思源插件 API**：获取 **`WorkspaceDir` 或 `TempDir` 的等价路径** 的官方方式（以思源文档为准）。  
- **`node-pty` 加载 hook**：优先查 **上游是否已有**「从自定义 `prebuilds` 根加载」的 **环境变量或导出 API**（随版本变化，实现时以锁定版本源码为准）。  
- **是否允许 `pacote` 进插件依赖**：会增加 bundle 体积与审计面；若不允许，则 **手写 registry JSON + tar 流解压**。

---

## 11. 参考

- [development.md](./development.md)  
- [rust-pty-sidecar.md](./rust-pty-sidecar.md)（PTY 侧车备选）  
- [microsoft/node-pty](https://github.com/microsoft/node-pty)  
- npm **`pacote`**（若采用）

---

## 12. 文档维护（已实现）

- **代码**：[`src/nodePtyResolver.ts`](../src/nodePtyResolver.ts)（registry 拉取、integrity、`temp` 分桶、并发与清理）、[`src/terminalDock.ts`](../src/terminalDock.ts)（异步加载与 UX）。
- **锁定版本**：源码常量 **`NODE_PTY_RESOLVED_VERSION`**（[`src/nodePtyResolver.ts`](../src/nodePtyResolver.ts)，当前 **1.1.0**）；本仓库 **package.json 不声明** `node-pty` 依赖。
- **缓存路径**：`<WorkspaceDir>/temp/plugin-<plugin.json 的 name>/<platform>-<arch>/<NODE_PTY_RESOLVED_VERSION>/node-pty/`。
- **加载策略**：**不** 从 `data/plugins/<插件名>/node_modules/node-pty` 加载；开发与发版均走 **registry + temp**。
- **Registry**：按 **origin** 去重后依次请求 packument；内置链为 **npm 官方 → npmmirror**（代码常量，不读环境变量）。
- **安装轨迹**：每次安装 / 解析均追加写入 **`temp/plugin-<name>/pty-install.log`**。
- **macOS spawn-helper**：**node-pty 1.1.0** 官方 tgz 中 **`prebuilds/*/spawn-helper`** 常为 **644**，解压后会导致 **`posix_spawnp failed`**；[`nodePtyResolver`](../src/nodePtyResolver.ts) 在返回包根路径前会检测并 **`chmod` 755**（见 [node-pty#850](https://github.com/microsoft/node-pty/issues/850)）。
- **解压实现**：使用 **系统 `tar`**（`tar -xzf … --strip-components=1`），要求桌面环境 PATH 中可用 `tar`（macOS / Linux / Windows 10+ 通常满足）。

详细开发与发版说明见 [development.md](./development.md)。
