#!/usr/bin/env node
/**
 * 在本机用 Node 复现插件拉取 node-pty 的流程（多 registry 候选 packument + tarball + sha512）。
 * 与 src/nodePtyResolver.ts 中版本号与内置候选列表保持一致。
 *
 * 用法：pnpm run test:registry
 */

import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

/** 与 src/nodePtyResolver.ts 中常量一致 */
const NODE_PTY_RESOLVED_VERSION = "1.1.0";
const DEFAULT_REGISTRY_BASE = "https://registry.npmjs.org/";
const DEFAULT_REGISTRY_CANDIDATES = [
    "https://registry.npmjs.org/",
    "https://registry.npmmirror.com/",
];
const PACKUMENT_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 180_000;

function normalizeRegistryBase(raw, fallback) {
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

function collectRegistryCandidateBases() {
    const seen = new Set();
    const out = [];
    const push = (raw) => {
        if (!raw?.trim()) {
            return;
        }
        const n = normalizeRegistryBase(raw, DEFAULT_REGISTRY_BASE);
        let origin;
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

function httpsGetBuffer(urlStr, maxRedirects, timeoutMs) {
    return new Promise((resolve, reject) => {
        const tryOnce = (u, redirectsLeft) => {
            const uo = new URL(u);
            const lib = uo.protocol === "http:" ? http : https;
            /** @type {import('node:https').RequestOptions} */
            const opts = {
                protocol: uo.protocol,
                hostname: uo.hostname,
                port: uo.port || undefined,
                path: uo.pathname + uo.search,
                method: "GET",
                headers: {"user-agent": "Terminal-plugin-test-registry"},
                agent: false,
            };
            const req = lib.request(opts, (res) => {
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
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve(Buffer.concat(chunks)));
                res.on("error", reject);
            });
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

async function fetchPackumentWithFallback() {
    const bases = collectRegistryCandidateBases();
    const failures = [];
    for (const base of bases) {
        const url = new URL(`node-pty/${NODE_PTY_RESOLVED_VERSION}`, base).href;
        try {
            const metaBuf = await httpsGetBuffer(url, 5, PACKUMENT_TIMEOUT_MS);
            const meta = JSON.parse(metaBuf.toString("utf8"));
            const tarball = meta.dist?.tarball;
            const integrity = meta.dist?.integrity;
            if (!tarball || !integrity) {
                throw new Error("packument 缺少 dist.tarball 或 dist.integrity");
            }
            if (!integrity.startsWith("sha512-")) {
                throw new Error("不支持的 integrity 格式");
            }
            return {packumentUrl: url, tarball, integrity};
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            failures.push(`${url} → ${msg}`);
        }
    }
    throw new Error(`所有 registry 源均失败：\n${failures.join("\n")}`);
}

function verifySha512(filePath, integrity) {
    const expectedB64 = integrity.slice("sha512-".length);
    const data = fs.readFileSync(filePath);
    const digestB64 = crypto.createHash("sha512").update(data).digest("base64");
    if (digestB64 !== expectedB64) {
        throw new Error("sha512 mismatch");
    }
}

async function main() {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(__dirname, "..");
    console.log("工作目录:", rootDir);
    console.log("候选 registry（按顺序）:", collectRegistryCandidateBases().join(" → "));
    console.log("node-pty 版本:", NODE_PTY_RESOLVED_VERSION);
    console.log("");

    console.log("[1/3] GET packument（自动换源直到成功）…");
    const {packumentUrl, tarball, integrity} = await fetchPackumentWithFallback();
    console.log("      成功:", packumentUrl);
    console.log("      tarball:", tarball);
    console.log("");

    const tgzPath = path.join(os.tmpdir(), `node-pty-test-${Date.now()}.tgz`);
    console.log("[2/3] GET tarball …");
    const tgzBuf = await httpsGetBuffer(tarball, 8, TARBALL_TIMEOUT_MS);
    fs.writeFileSync(tgzPath, tgzBuf);
    console.log("      已写入:", tgzPath, "大小:", tgzBuf.length, "bytes");
    console.log("");

    console.log("[3/3] 校验 integrity …");
    verifySha512(tgzPath, integrity);
    console.log("      OK");
    fs.unlinkSync(tgzPath);
    console.log("\n全部通过：本机 Node 可以完成与插件相同的下载与校验。");
}

main().catch((e) => {
    console.error("\n失败:", e.message || e);
    if (e.stack) {
        console.error(e.stack);
    }
    process.exit(1);
});
