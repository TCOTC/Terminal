/** 与 npm 拉取的 node-pty 版本一致（本仓库不声明 node-pty 依赖，仅在此常量锁定） */
export const NODE_PTY_RESOLVED_VERSION = "1.1.0";

/** 安装过程轨迹写入 `temp/plugin-<name>/pty-install.log` 时的回调类型 */
export type PtyInstallLog = (message: string) => void;

const DEFAULT_REGISTRY_BASE = "https://registry.npmjs.org/";
/** 内置候选：依次尝试，先成功的 packument 所带 tarball URL 用于下载（与 npm 官方元数据一致） */
const DEFAULT_REGISTRY_CANDIDATES = [
    "https://registry.npmjs.org/",
    "https://registry.npmmirror.com/",
];
const WAIT_OTHER_MS = 180_000;
const WAIT_POLL_MS = 200;
/** 拉取版本元数据（JSON）超时 */
const PACKUMENT_TIMEOUT_MS = 30_000;
/** 拉取 tarball 超时（体积较大） */
const TARBALL_TIMEOUT_MS = 180_000;

/** 使用系统 tar 解压 npm tgz（strip 顶层 package/），避免 webpack 捆绑 node 版 tar */
function extractTarballStrip1(
    nodeRequire: NodeJS.Require,
    tgzPath: string,
    cwd: string,
    log?: PtyInstallLog,
): void {
    log?.(`tar -xzf 开始 cwd=${cwd} tgz=${tgzPath}`);
    const cpMod = nodeRequire("child_process") as typeof import("child_process");
    const r = cpMod.spawnSync("tar", ["-xzf", tgzPath, "-C", cwd, "--strip-components=1"], {
        encoding: "utf8",
    });
    if (r.error) {
        log?.(`tar spawn 错误: ${r.error.message}`);
        throw r.error;
    }
    if (r.status !== 0) {
        const detail = (r.stderr || r.stdout || "").trim();
        log?.(`tar 退出码 ${r.status} stderr/stdout: ${detail}`);
        throw new Error(
            detail ? `tar extract failed: ${detail}` : `tar extract failed with exit ${r.status}`,
        );
    }
    log?.("tar 解压完成");
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function sanitizePathSegment(s: string): string {
    return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** `<WorkspaceDir>/temp/plugin-<name>`，与 `data/` 同级；node-pty 与本插件其它运行时产物均放其下子目录 */
export function getPluginTempRootDir(dataDir: string, pluginName: string, nodeRequire: NodeJS.Require): string {
    const pathMod = nodeRequire("path") as typeof import("path");
    const workspaceRoot = pathMod.dirname(dataDir);
    return pathMod.join(workspaceRoot, "temp", `plugin-${pluginName}`);
}

/** 分桶：`platform-arch` + `NODE_PTY_RESOLVED_VERSION` → `temp/plugin-<name>/<plat>/<ver>/node-pty/`。路径不含 `process.versions.modules`：思源升级若改变 ABI 而锁定版本未 bump，可能沿用不兼容缓存，需删该版本目录或 bump 版本。 */
export function getNodePtyBucketDir(dataDir: string, pluginName: string, nodeRequire: NodeJS.Require): string {
    const pathMod = nodeRequire("path") as typeof import("path");
    const proc = nodeRequire("process") as NodeJS.Process;
    const plat = `${proc.platform}-${proc.arch}`;
    const ver = sanitizePathSegment(NODE_PTY_RESOLVED_VERSION);
    return pathMod.join(getPluginTempRootDir(dataDir, pluginName, nodeRequire), plat, ver);
}

function markerPath(bucketDir: string, nodeRequire: NodeJS.Require): string {
    const pathMod = nodeRequire("path") as typeof import("path");
    return pathMod.join(bucketDir, "node-pty", "package.json");
}

function isExtractComplete(bucketDir: string, nodeRequire: NodeJS.Require): boolean {
    const fsMod = nodeRequire("fs") as typeof import("fs");
    return fsMod.existsSync(markerPath(bucketDir, nodeRequire));
}

function normalizeRegistryBase(raw: string | undefined, fallback: string): string {
    let s = (raw || fallback).trim();
    if (!s) {
        s = fallback;
    }
    if (!/^https?:\/\//i.test(s)) {
        s = `https://${s}`;
    }
    if (!s.endsWith("/")) {
        s += "/";
    }
    return s;
}

/** 按顺序去重（按 origin）：仅内置 registry 链 */
function collectRegistryCandidateBases(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (raw: string | undefined) => {
        if (!raw?.trim()) {
            return;
        }
        const n = normalizeRegistryBase(raw, DEFAULT_REGISTRY_BASE);
        let origin: string;
        try {
            origin = new URL(n).origin;
        } catch {
            return;
        }
        if (seen.has(origin)) {
            return;
        }
        seen.add(origin);
        out.push(n);
    };
    for (const b of DEFAULT_REGISTRY_CANDIDATES) {
        push(b);
    }
    return out;
}

function augmentNetworkErrorMessage(msg: string): string {
    const lower = msg.toLowerCase();
    if (
        lower.includes("tls") ||
        lower.includes("socket") ||
        lower.includes("econnreset") ||
        lower.includes("etimedout") ||
        lower.includes("enotfound") ||
        lower.includes("timeout") ||
        lower.includes("certificate") ||
        lower.includes("econnrefused")
    ) {
        return `${msg} （网络或 TLS 异常：请检查系统代理、VPN、防火墙；插件会依次尝试官方与 npmmirror 等内置 registry 源。）`;
    }
    return msg;
}

function removeBucketDirIfIncomplete(bucketDir: string, nodeRequire: NodeJS.Require): void {
    if (isExtractComplete(bucketDir, nodeRequire)) {
        return;
    }
    const fsMod = nodeRequire("fs") as typeof import("fs");
    try {
        const list = fsMod.readdirSync(bucketDir);
        if (list.length === 0) {
            fsMod.rmdirSync(bucketDir);
        }
    } catch {
        // 忽略：目录非空或已不存在
    }
}

/** 每次解析 / 安装均追加写入 `<工作空间>/temp/plugin-<name>/pty-install.log`（写入失败则静默） */
function createPtyInstallLog(
    nodeRequire: NodeJS.Require,
    dataDir: string,
    pluginName: string,
): PtyInstallLog {
    const pathMod = nodeRequire("path") as typeof import("path");
    const fsMod = nodeRequire("fs") as typeof import("fs");
    const logPath = pathMod.join(getPluginTempRootDir(dataDir, pluginName, nodeRequire), "pty-install.log");

    return (message: string) => {
        const line = `[${new Date().toISOString()}] ${message}\n`;
        try {
            fsMod.mkdirSync(pathMod.dirname(logPath), {recursive: true});
            fsMod.appendFileSync(logPath, line, "utf8");
        } catch {
            // 写入失败时忽略，避免影响主流程
        }
    };
}

interface NpmVersionDist {
    tarball?: string;
    integrity?: string;
}

function httpsGetBuffer(
    nodeRequire: NodeJS.Require,
    urlStr: string,
    maxRedirects: number,
    timeoutMs: number,
): Promise<Buffer> {
    const httpsMod = nodeRequire("https") as typeof import("https");
    const httpMod = nodeRequire("http") as typeof import("http");
    const {URL} = nodeRequire("url") as typeof import("url");
    return new Promise((resolve, reject) => {
        const tryOnce = (u: string, redirectsLeft: number) => {
            const uo = new URL(u);
            const lib = uo.protocol === "http:" ? httpMod : httpsMod;
            const reqOpts: {
                protocol?: string;
                hostname?: string;
                port?: string | number;
                path?: string;
                method: string;
                headers: {host: string; "user-agent": string};
                agent: boolean;
            } = {
                protocol: uo.protocol,
                hostname: uo.hostname,
                port: uo.port || undefined,
                path: uo.pathname + uo.search,
                method: "GET",
                headers: {host: uo.host, "user-agent": "Terminal-plugin-siyuan"},
                agent: false,
            };
            const req = lib.request(
                reqOpts,
                (res) => {
                    req.setTimeout(0);
                    const code = res.statusCode || 0;
                    if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
                        const next = new URL(res.headers.location, uo).toString();
                        res.resume();
                        tryOnce(next, redirectsLeft - 1);
                        return;
                    }
                    if (code !== 200) {
                        reject(new Error(`HTTP ${code} for ${u}`));
                        res.resume();
                        return;
                    }
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => {
                        chunks.push(c);
                    });
                    res.on("end", () => {
                        resolve(Buffer.concat(chunks));
                    });
                    res.on("error", (err) => {
                        reject(err);
                    });
                },
            );
            req.setTimeout(timeoutMs, () => {
                req.destroy();
                reject(new Error(`request timeout after ${timeoutMs}ms for ${u}`));
            });
            req.on("error", (err) => {
                req.setTimeout(0);
                reject(err);
            });
            req.end();
        };
        tryOnce(urlStr, maxRedirects);
    });
}

async function fetchNodePtyDistMeta(
    nodeRequire: NodeJS.Require,
    log?: PtyInstallLog,
): Promise<{tarball: string; integrity: string}> {
    const bases = collectRegistryCandidateBases();
    log?.(`packument：共 ${bases.length} 个 registry 候选`);
    const failures: string[] = [];
    for (const base of bases) {
        const url = new URL(`node-pty/${NODE_PTY_RESOLVED_VERSION}`, base).href;
        log?.(`packument 尝试 GET ${url}`);
        try {
            const buf = await httpsGetBuffer(nodeRequire, url, 5, PACKUMENT_TIMEOUT_MS);
            const text = buf.toString("utf8");
            let json: {dist?: NpmVersionDist};
            try {
                json = JSON.parse(text) as {dist?: NpmVersionDist};
            } catch {
                throw new Error("npm registry returned invalid JSON");
            }
            const tarball = json.dist?.tarball;
            const integrity = json.dist?.integrity;
            if (!tarball || !integrity) {
                throw new Error("npm packument missing dist.tarball or dist.integrity");
            }
            if (!integrity.startsWith("sha512-")) {
                throw new Error(`unsupported integrity format: ${integrity.slice(0, 16)}`);
            }
            log?.(`packument 成功，tarball=${tarball}`);
            return {tarball, integrity};
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log?.(`packument 失败 ${url} → ${msg}`);
            failures.push(`${url} → ${msg}`);
        }
    }
    log?.(`packument 全部失败:\n${failures.join("\n")}`);
    throw new Error(`所有 registry 源均无法拉取 packument：\n${failures.join("\n")}`);
}

function verifySha512Integrity(
    nodeRequire: NodeJS.Require,
    filePath: string,
    integrity: string,
    log?: PtyInstallLog,
): void {
    const cryptoMod = nodeRequire("crypto") as typeof import("crypto");
    const fsMod = nodeRequire("fs") as typeof import("fs");
    const expectedB64 = integrity.slice("sha512-".length);
    const data = fsMod.readFileSync(filePath);
    log?.(`sha512 校验开始 文件大小=${data.length}`);
    const digestB64 = cryptoMod.createHash("sha512").update(data).digest("base64");
    if (digestB64 !== expectedB64) {
        log?.("sha512 校验失败");
        throw new Error("downloaded tarball integrity check failed (sha512 mismatch)");
    }
    log?.("sha512 校验通过");
}

async function downloadTarball(
    nodeRequire: NodeJS.Require,
    url: string,
    destPath: string,
    log?: PtyInstallLog,
): Promise<void> {
    const fsMod = nodeRequire("fs") as typeof import("fs");
    log?.(`tarball 下载开始 → ${destPath} URL=${url}`);
    const buf = await httpsGetBuffer(nodeRequire, url, 8, TARBALL_TIMEOUT_MS);
    fsMod.writeFileSync(destPath, buf);
    log?.(`tarball 已写入 字节数=${buf.length}`);
}

function rmRecursive(nodeRequire: NodeJS.Require, p: string): void {
    const fsMod = nodeRequire("fs") as typeof import("fs");
    try {
        fsMod.rmSync(p, {recursive: true, force: true});
    } catch {
        // 忽略清理失败
    }
}

function pruneOtherPrebuilds(ptyRoot: string, nodeRequire: NodeJS.Require): void {
    const pathMod = nodeRequire("path") as typeof import("path");
    const fsMod = nodeRequire("fs") as typeof import("fs");
    const proc = nodeRequire("process") as NodeJS.Process;
    const root = pathMod.join(ptyRoot, "prebuilds");
    if (!fsMod.existsSync(root)) {
        return;
    }
    const keep = `${proc.platform}-${proc.arch}`;
    let names: string[];
    try {
        names = fsMod.readdirSync(root);
    } catch {
        return;
    }
    for (const name of names) {
        if (name === keep) {
            continue;
        }
        rmRecursive(nodeRequire, pathMod.join(root, name));
    }
}

/**
 * npm tgz 中 darwin 的 spawn-helper 常为 644，tar 解压后会导致 posix_spawnp failed（microsoft/node-pty#850）。
 * 在返回 require 根路径前为 prebuilds 下各 spawn-helper 补上可执行位（已具可执行位则跳过）。
 */
function ensureDarwinSpawnHelperExecutable(
    ptyRoot: string,
    nodeRequire: NodeJS.Require,
    log: PtyInstallLog,
): void {
    const proc = nodeRequire("process") as NodeJS.Process;
    if (proc.platform !== "darwin") {
        return;
    }
    const pathMod = nodeRequire("path") as typeof import("path");
    const fsMod = nodeRequire("fs") as typeof import("fs");
    const prebuilds = pathMod.join(ptyRoot, "prebuilds");
    if (!fsMod.existsSync(prebuilds)) {
        return;
    }
    let names: string[];
    try {
        names = fsMod.readdirSync(prebuilds);
    } catch {
        return;
    }
    let patched = 0;
    for (const name of names) {
        const helper = pathMod.join(prebuilds, name, "spawn-helper");
        try {
            if (!fsMod.existsSync(helper)) {
                continue;
            }
            const st = fsMod.statSync(helper);
            if (!st.isFile()) {
                continue;
            }
            if ((st.mode & 0o100) !== 0) {
                continue;
            }
            fsMod.chmodSync(helper, 0o755);
            patched += 1;
        } catch {
            // 忽略单个文件
        }
    }
    if (patched > 0) {
        log(`darwin: 已为 ${patched} 个 spawn-helper 补上可执行位（避免包内 644 导致 posix_spawnp failed）`);
    }
}

function finalizePtyRoot(bucketDir: string, nodeRequire: NodeJS.Require, log: PtyInstallLog): string {
    const pathMod = nodeRequire("path") as typeof import("path");
    const ptyRoot = pathMod.join(bucketDir, "node-pty");
    ensureDarwinSpawnHelperExecutable(ptyRoot, nodeRequire, log);
    return ptyRoot;
}

/** 是否需从 registry 拉取或等待解压（缓存未就绪） */
export function needsOnlineNodePtyInstall(
    dataDir: string,
    pluginName: string,
    nodeRequire: NodeJS.Require,
): boolean {
    const bucketDir = getNodePtyBucketDir(dataDir, pluginName, nodeRequire);
    return !isExtractComplete(bucketDir, nodeRequire);
}

async function waitUntilCacheReady(
    bucketDir: string,
    nodeRequire: NodeJS.Require,
): Promise<boolean> {
    const deadline = Date.now() + WAIT_OTHER_MS;
    while (Date.now() < deadline) {
        if (isExtractComplete(bucketDir, nodeRequire)) {
            return true;
        }
        await sleep(WAIT_POLL_MS);
    }
    return isExtractComplete(bucketDir, nodeRequire);
}

/**
 * 解析可 require 的 node-pty 包根目录（由调用方 require）。
 * 仅从 temp 分桶缓存加载；未命中时从 npm 拉取官方 tgz 解压。
 */
export async function resolveNodePtyRoot(
    dataDir: string,
    pluginName: string,
    nodeRequire: NodeJS.Require,
): Promise<string> {
    const pathMod = nodeRequire("path") as typeof import("path");
    const fsMod = nodeRequire("fs") as typeof import("fs");
    const proc = nodeRequire("process") as NodeJS.Process;
    const log = createPtyInstallLog(nodeRequire, dataDir, pluginName);
    log(
        `resolveNodePtyRoot 开始 plugin=${pluginName} NODE_PTY_RESOLVED_VERSION=${NODE_PTY_RESOLVED_VERSION} electron=${proc.versions.electron} modules=${proc.versions.modules} platform=${proc.platform} arch=${proc.arch}`,
    );

    const bucketDir = getNodePtyBucketDir(dataDir, pluginName, nodeRequire);
    log(`bucketDir=${bucketDir}`);
    if (isExtractComplete(bucketDir, nodeRequire)) {
        log("缓存已存在（package.json），跳过下载");
        return finalizePtyRoot(bucketDir, nodeRequire, log);
    }

    await sleep(WAIT_POLL_MS);
    if (isExtractComplete(bucketDir, nodeRequire)) {
        log("短暂等待后检测到缓存已就绪");
        return finalizePtyRoot(bucketDir, nodeRequire, log);
    }

    fsMod.mkdirSync(bucketDir, {recursive: true});
    log("已创建 bucket 目录（若尚不存在）");

    const workId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const parentDir = pathMod.dirname(bucketDir);
    const workDir = pathMod.join(parentDir, `${pathMod.basename(bucketDir)}.work-${workId}`);
    const tgzPath = pathMod.join(workDir, "package.tgz");
    const extractInto = pathMod.join(workDir, "node-pty");
    log(`workDir=${workDir}`);

    try {
        fsMod.mkdirSync(extractInto, {recursive: true});

        const {tarball, integrity} = await fetchNodePtyDistMeta(nodeRequire, log);
        await downloadTarball(nodeRequire, tarball, tgzPath, log);
        verifySha512Integrity(nodeRequire, tgzPath, integrity, log);

        extractTarballStrip1(nodeRequire, tgzPath, extractInto, log);

        const stagedPty = extractInto;
        const finalPty = pathMod.join(bucketDir, "node-pty");

        try {
            log(`rename ${stagedPty} → ${finalPty}`);
            fsMod.renameSync(stagedPty, finalPty);
            log("rename 完成");
        } catch (e) {
            const err = e as NodeJS.ErrnoException;
            log(`rename 异常 code=${err.code} message=${err.message}`);
            if (
                err.code === "EEXIST" ||
                err.code === "ENOTEMPTY" ||
                isExtractComplete(bucketDir, nodeRequire)
            ) {
                rmRecursive(nodeRequire, workDir);
                log("并发安装已完成，使用已有缓存");
                return finalizePtyRoot(bucketDir, nodeRequire, log);
            }
            throw e;
        }

        pruneOtherPrebuilds(finalPty, nodeRequire);
        rmRecursive(nodeRequire, workDir);
        log("安装流程成功结束，已清理 workDir");
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const errStack = e instanceof Error ? e.stack : "";
        log(`catch 错误: ${errMsg}`);
        if (errStack) {
            log(`stack:\n${errStack}`);
        }
        rmRecursive(nodeRequire, workDir);
        if (isExtractComplete(bucketDir, nodeRequire)) {
            log("catch 后检测到缓存已完整，返回缓存路径");
            return finalizePtyRoot(bucketDir, nodeRequire, log);
        }
        const waited = await waitUntilCacheReady(bucketDir, nodeRequire);
        if (waited) {
            log("waitUntilCacheReady 后检测到缓存就绪");
            return finalizePtyRoot(bucketDir, nodeRequire, log);
        }
        removeBucketDirIfIncomplete(bucketDir, nodeRequire);
        const rawMsg = e instanceof Error ? e.message : String(e);
        throw new Error(augmentNetworkErrorMessage(rawMsg));
    }

    log(`返回 require 根路径 ${pathMod.join(bucketDir, "node-pty")}`);
    return finalizePtyRoot(bucketDir, nodeRequire, log);
}
