"use strict";

/**
 * updater.js —— dsh 载荷在线更新（轻量版）
 *
 * 无需对方机器安装 npm：这里用纯 Node 实现依赖闭包解析
 * （BFS + 语义化版本选择 + 平台过滤 + 扁平/嵌套布局），
 * 从 npm registry 直接下载各包 tarball，校验 SHA-512 后解压到暂存目录。
 * 原子切换与回滚由 main.js 的 applyUpdate 负责。
 */

const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const semver = require("semver");
const tar = require("tar");

const PKG_NAME = "@deepseek-ai/dsh";
// 下载源（npm registry）：
//  - 默认国内镜像源 npmmirror：国内直连快；@deepseek-ai/dsh 的 tarball 与
//    SHA-512 integrity 与官方源完全一致（已实测），解析/校验逻辑不受影响
//  - 环境变量 DSH_DESKTOP_NPM_REGISTRY 最高优先级（可指回官方源或自建源）
//  - main.js 可从应用配置恢复 / 菜单「下载源」切换（setRegistry）
const DEFAULT_REGISTRY = "https://registry.npmmirror.com";
let REGISTRY = process.env.DSH_DESKTOP_NPM_REGISTRY || DEFAULT_REGISTRY;

/** 切换下载源。环境变量优先：设置了 DSH_DESKTOP_NPM_REGISTRY 时忽略本次设置。 */
function setRegistry(url) {
  if (process.env.DSH_DESKTOP_NPM_REGISTRY) return;
  REGISTRY = url && url.trim() ? url.trim().replace(/\/+$/, "") : DEFAULT_REGISTRY;
}

/** 当前生效的下载源（供 UI 显示/菜单勾选） */
function getRegistry() {
  return REGISTRY;
}

const ACCEPT = "application/vnd.npm.install-v1+json";

function pkgUrl(name) {
  return `${REGISTRY}/${name}`;
}

async function fetchJson(url, { timeoutMs = 30000, abbreviated = false } = {}) {
  const res = await fetchWithRetry(url, {
    timeoutMs,
    headers: { Accept: abbreviated ? ACCEPT : "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** 提取 undici 错误的底层原因链（如 ECONNRESET / ENOTFOUND / TLS 错误），供日志与弹窗定位 */
function causeInfo(err) {
  const parts = [];
  let cur = err && err.cause;
  let depth = 0;
  while (cur && depth < 3) {
    const label = `${cur.code || cur.name || ""} ${cur.message || ""}`.trim();
    if (label) parts.push(label);
    cur = cur.cause;
    depth += 1;
  }
  return parts.join(" -> ");
}

// ---------------------------------------------------------------------------
// 系统代理支持（仅直连全部失败后的兜底通道，优先直连）
//  - 手动指定：环境变量 DSH_DESKTOP_SYSTEM_PROXY（值格式同 Windows ProxyServer）
//  - 自动检测：读注册表 HKCU\...\Internet Settings 的 ProxyEnable / ProxyServer
//    （Clash/V2RayN 等开「系统代理」时写入的位置）
//  - 结果会话内缓存；代理请求通过 undici dispatcher 显式注入，
//    不影响主进程其他 fetch（本地探活等）
// ---------------------------------------------------------------------------

let cachedProxy = null;
let proxyChecked = false;

/** 解析 Windows ProxyServer 值："host:port" / "http=...;https=..." / "socks=..." */
function parseProxyServer(raw) {
  if (!raw || typeof raw !== "string") return null;
  const parts = raw.split(";").map((s) => s.trim()).filter(Boolean);
  let httpHost = null;
  let socksHost = null;
  for (const p of parts) {
    const m = /^(https?|socks[45]?|ftp)=(.+)$/i.exec(p);
    if (m) {
      const proto = m[1].toLowerCase();
      const host = m[2].trim();
      if (!host) continue;
      if (proto === "http" || proto === "https") httpHost = httpHost || host;
      else if (proto.startsWith("socks")) socksHost = socksHost || host;
    } else if (!httpHost && /^[\w.-]+:\d+$/.test(p)) {
      httpHost = p; // 无协议前缀的单一 host:port 应用于所有协议
    }
  }
  if (httpHost) return { type: "http", url: `http://${httpHost}` };
  if (socksHost) return { type: "socks", url: `socks5://${socksHost}` };
  return null;
}

/** 读取当前系统代理：环境变量 DSH_DESKTOP_SYSTEM_PROXY > 注册表；结果缓存 */
function readSystemProxy() {
  if (proxyChecked) return cachedProxy;
  proxyChecked = true;
  try {
    const manual = process.env.DSH_DESKTOP_SYSTEM_PROXY;
    if (manual && manual.trim()) {
      cachedProxy = parseProxyServer(manual);
      return cachedProxy;
    }
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enable = execFileSync("reg.exe", ["query", key, "/v", "ProxyEnable"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (!/0x1\b/i.test(enable)) return (cachedProxy = null); // 系统代理未开启
    const server = execFileSync("reg.exe", ["query", key, "/v", "ProxyServer"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    const line = server.split(/\r?\n/).find((l) => /ProxyServer/i.test(l)) || "";
    cachedProxy = parseProxyServer(line.split(/REG_SZ/)[1] || "");
  } catch {
    cachedProxy = null;
  }
  return cachedProxy;
}

let proxyAgent = null;

/** 惰性创建并缓存 undici 代理 agent；undici 不可用/无代理时返回 null */
function getProxyAgent() {
  const info = readSystemProxy();
  if (!info) return null;
  if (proxyAgent) return proxyAgent;
  try {
    const undici = require("undici");
    proxyAgent =
      info.type === "socks" ? new undici.Socks5ProxyAgent(info.url) : new undici.ProxyAgent(info.url);
    return proxyAgent;
  } catch {
    return null;
  }
}

const UA_HEADERS = { "User-Agent": "dsh-desktop-updater" };

/**
 * fetch 封装：直连优先，网络层失败自动重试（指数退避 0.5s/1s/2s）；
 * 直连全部失败后，若检测到系统代理开启，自动改走系统代理再试一轮；
 * 仍失败或没有代理时，抛出的错误带完整 URL、直连原因与代理尝试结果。
 * HTTP 非 2xx 不重试（404/403 重试无意义）。
 */
async function fetchWithRetry(url, { timeoutMs = 30000, headers = {}, retries = 2 } = {}) {
  const requestHeaders = { ...UA_HEADERS, ...headers };
  let directErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: requestHeaders });
    } catch (err) {
      directErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  // —— 直连全部失败：尝试系统代理兜底 ——
  const agent = getProxyAgent();
  if (agent) {
    const info = readSystemProxy();
    try {
      return await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: requestHeaders,
        dispatcher: agent,
      });
    } catch (proxyErr) {
      const directCause = causeInfo(directErr);
      const proxyCause = causeInfo(proxyErr);
      throw new Error(
        `网络请求失败 ${url}: 直连失败（${directErr.message}${directCause ? `，原因: ${directCause}` : ""}）；` +
          `系统代理 ${info.url} 重试也失败（${proxyErr.message}${proxyCause ? `，原因: ${proxyCause}` : ""}）`,
      );
    }
  }
  const cause = causeInfo(directErr);
  throw new Error(
    `网络请求失败 ${url}: ${directErr.message}${cause ? `（原因: ${cause}）` : ""}；未检测到开启的系统代理`,
  );
}

/** npm 的 os/cpu 平台匹配（支持 "win32"、"!linux" 与数组） */
function listOk(manifest, field, value) {
  const raw = manifest[field];
  if (raw === undefined) return true;
  const list = Array.isArray(raw) ? raw : [raw];
  let hasPositive = false;
  for (const item of list) {
    if (item.startsWith("!")) {
      if (item.slice(1) === value) return false;
    } else {
      hasPositive = true;
      if (item === value) return true;
    }
  }
  return !hasPositive;
}

/** 查询 registry 上 @deepseek-ai/dsh 的最新版本号 */
async function getLatestVersion() {
  const m = await fetchJson(`${pkgUrl(PKG_NAME)}/latest`);
  if (typeof m.version !== "string") throw new Error("registry 响应缺少 version 字段");
  return m.version;
}

/**
 * 解析依赖闭包（不下载）：BFS + 语义化版本选择 + 平台过滤 + 扁平/嵌套布局。
 * @param {string} version - @deepseek-ai/dsh 的目标版本
 * @returns {Promise<{ chosen: Map<string,{version:string,manifest:object}>, nested: Map<string,{version:string,manifest:object}> }>}
 */
async function resolvePlan(version) {
  const root = await fetchJson(`${pkgUrl(PKG_NAME)}/${version}`);
  if (root.name !== PKG_NAME) throw new Error(`registry 返回异常：${root.name}`);

  const chosen = new Map(); // name -> { version, manifest }
  const nested = new Map(); // "requirer/name" -> { version, manifest }
  const packuments = new Map();

  async function packument(name) {
    if (!packuments.has(name)) packuments.set(name, await fetchJson(pkgUrl(name), { abbreviated: true }));
    return packuments.get(name);
  }

  /** 为 (name, range) 挑一个满足平台约束的最高版本；
   *  返回 { version, manifest }；范围无匹配返回 null；范围有匹配但平台不符返回 { platformMismatch: true } */
  async function pick(name, range) {
    const pack = await packument(name);
    const versions = Object.keys(pack.versions || {});
    const sat = versions.filter((v) => semver.satisfies(v, range, { includePrerelease: true }));
    if (sat.length === 0) return null;
    const cands = sat.filter(
      (v) => listOk(pack.versions[v], "os", "win32") && listOk(pack.versions[v], "cpu", "x64"),
    );
    if (cands.length === 0) return { platformMismatch: true };
    const v = semver.maxSatisfying(cands, range, { includePrerelease: true });
    return { version: v, manifest: pack.versions[v] };
  }

  const queued = new Set();
  const queue = [{ name: PKG_NAME, range: version, requirer: null, optional: false }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (queued.has(item.name)) continue;
    queued.add(item.name);

    let info;
    if (item.name === PKG_NAME) {
      info = { version, manifest: root };
    } else {
      try {
        info = await pick(item.name, item.range);
      } catch (err) {
        if (item.optional) continue; // 可选依赖不可用可接受
        throw err;
      }
      if (!info) {
        if (item.optional) continue; // 可选依赖范围无匹配可接受
        throw new Error(`无法解析依赖 ${item.name}@${item.range}`);
      }
      if (info.platformMismatch) continue; // 平台不匹配：npm 同样跳过（含普通依赖）
    }
    const prev = chosen.get(item.name);
    if (prev) {
      // 同一包被再次需要：若已选版本不满足新范围，则在该 requirer 下嵌套一份
      if (!semver.satisfies(prev.version, item.range, { includePrerelease: true })) {
        nested.set(`${item.requirer}/${item.name}`, info);
      }
      continue;
    }
    chosen.set(item.name, info);

    const m = info.manifest;
    const deps = { ...(m.dependencies || {}) };
    const peerMeta = m.peerDependenciesMeta || {};
    for (const [depName, depRange] of Object.entries(m.peerDependencies || {})) {
      // npm 对 peerDependenciesMeta 标记 optional 的 peer 同样跳过
      if (peerMeta[depName] && peerMeta[depName].optional) continue;
      deps[depName] = depRange;
    }
    for (const [depName, depRange] of Object.entries(deps)) {
      if (!queued.has(depName)) queue.push({ name: depName, range: depRange, requirer: item.name, optional: false });
    }
    for (const [depName, depRange] of Object.entries(m.optionalDependencies || {})) {
      if (!queued.has(depName)) queue.push({ name: depName, range: depRange, requirer: item.name, optional: true });
    }
  }

  return { chosen, nested };
}

/**
 * 解析并下载指定版本的完整依赖闭包到 stageDir。
 * @param {string} version - 目标版本（如 "0.1.0-rc.7"）
 * @param {string} stageDir - 暂存目录（最终会整体切换为服务端载荷目录）
 * @param {(done:number, total:number, name:string) => void} [onProgress]
 */
async function prepareUpdate(version, stageDir, onProgress) {
  const { chosen, nested } = await resolvePlan(version);

  // 收集下载清单（扁平 + 一层嵌套）
  const downloads = [];
  for (const [name, info] of chosen) {
    downloads.push({ name, version: info.version, manifest: info.manifest, relDir: path.join("node_modules", ...name.split("/")) });
  }
  for (const [key, info] of nested) {
    const sep = key.indexOf("/");
    const requirer = key.slice(0, sep);
    const name = key.slice(sep + 1);
    downloads.push({
      name,
      version: info.version,
      manifest: info.manifest,
      relDir: path.join("node_modules", ...requirer.split("/"), "node_modules", ...name.split("/")),
    });
  }

  await fs.promises.rm(stageDir, { recursive: true, force: true });
  await fs.promises.mkdir(stageDir, { recursive: true });
  // 与内置载荷布局一致：payload 根有 package.json + node_modules
  fs.writeFileSync(
    path.join(stageDir, "package.json"),
    JSON.stringify({ name: "dsh-server-payload", private: true, version, dependencies: { [PKG_NAME]: version } }, null, 2) + "\n",
  );

  // 下载 + 校验 + 解压（小并发池，控制内存）
  const total = downloads.length;
  let done = 0;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(6, total) }, async () => {
    for (;;) {
      const idx = nextIndex++;
      if (idx >= total) return;
      const d = downloads[idx];
      const targetDir = path.join(stageDir, d.relDir);
      const res = await fetchWithRetry(d.manifest.dist.tarball, { timeoutMs: 180000, retries: 1 });
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${d.name}@${d.version}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const integrity = d.manifest.dist && d.manifest.dist.integrity;
      if (integrity) {
        const m = /^sha(512|1)-(.*)$/.exec(integrity);
        if (m) {
          const actual = crypto.createHash(`sha${m[1]}`).update(buf).digest("base64");
          if (actual !== m[2]) throw new Error(`完整性校验失败：${d.name}@${d.version}`);
        }
      }
      await fs.promises.mkdir(targetDir, { recursive: true });
      await new Promise((resolve, reject) => {
        const stream = tar.x({ cwd: targetDir, strip: 1 });
        stream.on("close", resolve);
        stream.on("error", reject);
        Readable.from(buf).pipe(stream);
      });
      done += 1;
      if (onProgress) onProgress(done, total, d.name);
    }
  });
  await Promise.all(workers);

  // 更新元信息
  fs.writeFileSync(
    path.join(stageDir, ".installed.json"),
    JSON.stringify({ name: PKG_NAME, version }, null, 2),
  );
  return { version, packageCount: downloads.length };
}

/**
 * 下载官方 Node.js 运行时到 destDir（node.exe + 官方 LICENSE）。
 * 应用不再内置 node.exe（开源版），首次运行由本函数从 nodejs.org 获取；
 * destDir 放在数据目录内、独立于载荷目录（在线更新切换载荷时不会被丢弃）。
 * @param {string} destDir - 目标目录（写入 node.exe 与 LICENSE）
 * @param {(done:number, total:number, name:string) => void} [onProgress]
 */
async function downloadNodeRuntime(destDir, onProgress) {
  const NODE_VERSION = "v24.19.0";
  const base = `node-${NODE_VERSION}-win-x64`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${base}.zip`;
  if (onProgress) onProgress(0, 1, "node");
  const res = await fetchWithRetry(url, { timeoutMs: 600000, retries: 1 });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Windows 自带 tar.exe 支持 zip；只解出 node.exe 与 LICENSE（MIT 再分发需保留版权声明）
  const tmp = path.join(path.dirname(destDir), `.node-dl-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const zipPath = path.join(tmp, "node.zip");
  fs.writeFileSync(zipPath, buf);
  execFileSync("tar.exe", ["-xf", zipPath, "-C", tmp, `${base}/node.exe`, `${base}/LICENSE`], {
    stdio: "ignore",
  });
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(path.join(tmp, base, "node.exe"), path.join(destDir, "node.exe"));
  fs.copyFileSync(path.join(tmp, base, "LICENSE"), path.join(destDir, "LICENSE"));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (onProgress) onProgress(1, 1, "node");
}

module.exports = {
  PKG_NAME,
  DEFAULT_REGISTRY,
  setRegistry,
  getRegistry,
  causeInfo,
  parseProxyServer,
  readSystemProxy,
  fetchWithRetry,
  getLatestVersion,
  resolvePlan,
  prepareUpdate,
  downloadNodeRuntime,
};
