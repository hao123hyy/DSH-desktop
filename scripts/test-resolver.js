"use strict";
// 对照测试：registry 解析出的 rc.6 闭包 vs 内置（npm 安装的）闭包，包名集合应完全一致
const fs = require("node:fs");
const path = require("node:path");
const updater = require("../updater.js");

function bundledClosureNames() {
  const nm = path.resolve("resources/dsh-server/node_modules");
  const names = new Set();
  for (const entry of fs.readdirSync(nm)) {
    if (entry === ".bin" || entry === ".package-lock.json") continue;
    const p = path.join(nm, entry);
    if (!fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink()) continue;
    if (entry.startsWith("@")) {
      for (const sub of fs.readdirSync(p)) {
        if (fs.lstatSync(path.join(p, sub)).isDirectory()) names.add(`${entry}/${sub}`);
      }
    } else {
      names.add(entry);
    }
  }
  return names;
}

(async () => {
  const version = process.argv[2] || "0.1.0-rc.6";
  console.log(`resolving ${version} ...`);
  const t0 = Date.now();
  const { chosen, nested } = await updater.resolvePlan(version);
  console.log(`resolved in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${chosen.size} hoisted + ${nested.size} nested`);

  const resolved = new Set(chosen.keys());
  for (const k of nested.keys()) resolved.add(k);

  const bundled = bundledClosureNames();
  const onlyResolved = [...resolved].filter((n) => !bundled.has(n)).sort();
  const onlyBundled = [...bundled].filter((n) => !resolved.has(n)).sort();
  console.log(`bundled closure: ${bundled.size} packages`);
  console.log(`only in resolved (not bundled): ${onlyResolved.length}`);
  onlyResolved.slice(0, 30).forEach((n) => console.log("  +", n));
  console.log(`only in bundled (not resolved): ${onlyBundled.length}`);
  onlyBundled.slice(0, 30).forEach((n) => console.log("  -", n));

  // 版本一致性抽查：关键包是否解析到与内置一致的最高版本
  const check = ["@deepseek-ai/dsh-app-boot", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "semver", "tar", "node-pty", "sharp", "@img/sharp-win32-x64"];
  for (const name of check) {
    const info = chosen.get(name);
    if (info) console.log(`  ${name} -> ${info.version}`);
    else console.log(`  ${name} -> (not in closure!)`);
  }
  process.exit(0);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
