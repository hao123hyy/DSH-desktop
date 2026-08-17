"use strict";

/**
 * prepare-payload.js —— 为开发模式准备本地服务端载荷（幂等，可反复执行）
 *
 * 背景：GitHub 仓库不携带闭源闭包（resources/ 已被 .gitignore 排除），
 * 克隆后 `npm install`（postinstall 钩子调用本脚本）自动把
 * @deepseek-ai/dsh 完整依赖闭包下载到 resources/dsh-server，
 * `npm start` 开发模式即可直接使用；打包产物不含闭包（用户首次运行 exe 时在线下载）。
 *
 * 用法：node scripts/prepare-payload.js [--force]
 *   --force   强制把载荷刷新到 registry 上的最新版本（默认仅在缺失时补齐）
 * 环境变量：DSH_DESKTOP_NPM_REGISTRY（同 updater.js）
 */

const fs = require("node:fs");
const path = require("node:path");
const updater = require("../updater");

const ROOT = path.join(__dirname, "..");
const PAYLOAD_DIR = path.join(ROOT, "resources", "dsh-server");
const PAYLOAD_MARKER = path.join(
  PAYLOAD_DIR,
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
);

const FORCE = process.argv.includes("--force");

(async () => {
  try {
    // CI 环境（GitHub Actions 等自动设置 CI=true）：构建产物不携带闭包，
    // 跳过下载以免浪费 200MB；同时保证 npm install 的 electron postinstall 正常执行。
    if (process.env.CI && !FORCE) {
      console.log("CI 环境：跳过闭包下载（打包产物不含闭包，用户首装在线下载）");
      return;
    }
    if (fs.existsSync(PAYLOAD_MARKER) && !FORCE) {
      console.log("服务端载荷已存在，跳过（--force 可刷新到最新版）");
      return;
    }
    console.log("查询 registry 最新版本 ...");
    const version = await updater.getLatestVersion();
    console.log(`最新版本 ${version}，下载闭包（约 200MB，含 SHA-512 校验）...`);
    const { packageCount } = await updater.prepareUpdate(version, PAYLOAD_DIR, (done, total, name) => {
      if (done % 50 === 0 || done === total) console.log(`  ${done}/${total} ${name}`);
    });
    console.log(`完成：${packageCount} 个包已就绪`);
  } catch (err) {
    console.error("[prepare-payload] 失败:", err && err.message ? err.message : err);
    process.exit(1);
  }
})();
