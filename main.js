"use strict";

/**
 * DSH桌面版 —— DeepSeek Harness 桌面客户端
 *
 * 职责：
 *  1. 静默拉起内置的 dsh web 服务（无任何控制台窗口）
 *  2. 在一个独立 Electron 窗口中加载 Web UI
 *  3. 窗口关闭时杀死服务进程树，不留孤儿进程
 *
 * 数据位置（可覆盖）：
 *  - DSH_DESKTOP_DATA_DIR   应用数据目录（日志、服务端载荷缓存），默认 %APPDATA%\dsh-desktop
 *  - DSH_DESKTOP_SERVER_DIR 直接指定服务端载荷目录（跳过复制）
 *  - DSH_HOME               dsh 数据目录（会话/工作区/凭据），默认 %USERPROFILE%\.dsh
 */

const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const semver = require("semver");
const updater = require("./updater");

const APP_NAME = "DSH桌面版";
const BIND_HOST = "127.0.0.1";
const SERVER_READY_TIMEOUT_MS = 120_000; // 首次启动可能较慢
const SERVER_READY_POLL_MS = 300;

// ---------------------------------------------------------------------------
// 路径与目录
// ---------------------------------------------------------------------------

const dataDir =
  process.env.DSH_DESKTOP_DATA_DIR || path.join(app.getPath("appData"), "dsh-desktop");
// 所有运行时写盘都集中到这里（%APPDATA%\dsh-desktop 或覆盖目录）
app.setPath("userData", dataDir);

const LOG_PATH = path.join(dataDir, "server.log");
const CONFIG_PATH = path.join(dataDir, "config.json");

/** 打包后资源目录为 process.resourcesPath；开发模式为项目 resources/ */
function resourceDir() {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, "resources");
}

/** 服务端载荷目录：环境变量 > 数据目录内的稳定副本 > 开发模式项目内副本 */
function serverPayloadDir() {
  if (process.env.DSH_DESKTOP_SERVER_DIR) return process.env.DSH_DESKTOP_SERVER_DIR;
  if (!app.isPackaged) return path.join(resourceDir(), "dsh-server");
  return path.join(dataDir, "server");
}

/** 当前生效的 dsh 内核版本（从服务端载荷读取） */
function currentDshVersion(payloadDir) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(payloadDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "未知";
  } catch {
    return "未知";
  }
}

// ---------------------------------------------------------------------------
// 应用配置（config.json，dataDir 下）：目前只有下载源（registry）
// ---------------------------------------------------------------------------

function loadAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveAppConfig(patch) {
  const cfg = { ...loadAppConfig(), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

/** 确保服务端载荷就位（打包态）。
 *  - 有在线标记（.updated.json）→ 直接用现有版本，跳过；
 *  - 有内置载荷（旧构建/手动放入）→ 复制到稳定的数据目录（原逻辑）；
 *  - 无内置载荷（仓库/发布版不含闭源闭包）→ 首次运行在线下载完整依赖闭包（约 200MB），
 *    完成后原子切换并写 .updated.json，与更新流程同语义（在线版本优先）。
 *  开发模式直接使用项目内 resources/dsh-server（由 npm install 的 postinstall 准备），不在此处理。 */
async function ensurePayload(updateStatus) {
  if (process.env.DSH_DESKTOP_SERVER_DIR || !app.isPackaged) return;
  const src = path.join(resourceDir(), "dsh-server");
  const dst = serverPayloadDir();
  // 在线更新/在线首装接管后，不再用内置载荷覆盖已更新的内容
  if (fs.existsSync(path.join(dst, ".updated.json"))) return;
  const srcMarker = path.join(src, "node_modules", "@deepseek-ai", "dsh", "package.json");
  const dstMarker = path.join(dst, ".installed.json");
  if (fs.existsSync(srcMarker)) {
    // —— 内置载荷路径（旧版打包产物或手动放入的载荷）——
    let fresh = false;
    if (fs.existsSync(dstMarker)) {
      try {
        const a = JSON.parse(fs.readFileSync(dstMarker, "utf8"));
        const b = JSON.parse(fs.readFileSync(srcMarker, "utf8"));
        fresh = a.version === b.version;
      } catch {
        fresh = false;
      }
    }
    if (fresh) {
      return;
    }
    updateStatus("首次运行：正在准备内置服务端（约需一分钟）…");
    await fs.promises.rm(dst, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    // dereference: 展开符号链接（npm .bin 中的 junction），避免复制时权限问题；
    // filter 回调顺带统计进度，每 5000 个文件刷新一次状态
    let copied = 0;
    await fs.promises.cp(src, dst, {
      recursive: true,
      dereference: true,
      filter: (s) => {
        copied += 1;
        if (copied % 5000 === 0) updateStatus(`首次运行：正在准备内置服务端（${copied} 个文件）…`);
        return true;
      },
    });
    fs.writeFileSync(dstMarker, JSON.stringify(JSON.parse(fs.readFileSync(srcMarker, "utf8"))));
    updateStatus("服务端准备完成");
    return;
  }

  // —— 无内置载荷：首次运行在线下载完整依赖闭包 ——
  crashLog("payload: 无内置载荷，首次运行在线下载");
  updateStatus("首次运行：正在下载服务端组件（约 200MB，请保持网络畅通）…");
  const version = await updater.getLatestVersion();
  const stageDir = path.join(dataDir, ".first-run-stage");
  await updater.prepareUpdate(version, stageDir, (done, total) =>
    updateStatus(`首次运行：正在下载服务端组件（${done}/${total}）…`),
  );
  // 原子切换（服务尚未启动，无需停服；失败残留由 prepareUpdate 的 rm 覆盖）
  const bak = `${dst}.bak`;
  await fs.promises.rm(bak, { recursive: true, force: true });
  if (fs.existsSync(dst)) await fs.promises.rename(dst, bak);
  await fs.promises.rename(stageDir, dst);
  fs.writeFileSync(
    path.join(dst, ".updated.json"),
    JSON.stringify({ version, at: new Date().toISOString(), firstRun: true }),
  );
  await fs.promises.rm(bak, { recursive: true, force: true }).catch(() => {});
  // 下载内置 Node.js 运行时到数据目录（独立于载荷目录，更新切换载荷时不会被丢弃）；
  // 下载失败不致命：findNodeExecutable 会回退 PATH 中的 node
  const nodeDir = path.join(dataDir, "node");
  if (!fs.existsSync(path.join(nodeDir, "node.exe"))) {
    updateStatus("首次运行：正在下载 Node.js 运行时（约 90MB）…");
    try {
      await updater.downloadNodeRuntime(nodeDir, () =>
        updateStatus("首次运行：正在下载 Node.js 运行时…"),
      );
    } catch (err) {
      const ci = updater.causeInfo(err);
      crashLog(`payload: node 下载失败（将回退 PATH）: ${err.message}${ci ? `（原因: ${ci}）` : ""}`);
    }
  }
  updateStatus("服务端组件下载完成");
}

// ---------------------------------------------------------------------------
// dsh 模块链接（junction）引导
//
// dsh 启动时会维护 $DSH_HOME/profiles/node_modules 下的扁平模块链接
// （每个包一个 junction，指向安装闭包）。Node 的 fs.symlinkSync("junction")
// 在 Windows 上走 CreateSymbolicLinkW，需要 SeCreateSymbolicLinkPrivilege
// （管理员或开发者模式）；而 cmd 的 mklink /J 创建的是真 junction，
// 任何普通用户都无需特权。因此这里用 mklink /J 预建全部链接，
// 让 dsh 的 heal 逻辑全部变成 no-op，应用即可在无特权环境下运行。
// ---------------------------------------------------------------------------

function dshHomeDir() {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return env.trim();
  return path.join(os.homedir(), ".dsh");
}

function normalizeLinkTarget(t) {
  return String(t).replace(/^\\\\\?\?\\/, "").replace(/\//g, "\\");
}

/** 枚举 node_modules 里的全部包（含 @scope 两级目录），跳过 .bin 等非包目录 */
function enumeratePackages(nodeModulesDir) {
  const packages = [];
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir);
  } catch {
    return packages;
  }
  for (const entry of entries) {
    if (entry === ".bin" || entry === ".package-lock.json") continue;
    const p = path.join(nodeModulesDir, entry);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (entry.startsWith("@")) {
      let subs;
      try {
        subs = fs.readdirSync(p);
      } catch {
        continue;
      }
      for (const sub of subs) {
        const sp = path.join(p, sub);
        try {
          if (fs.lstatSync(sp).isDirectory()) packages.push(path.join(entry, sub));
        } catch {
          /* 跳过 */
        }
      }
    } else {
      packages.push(entry);
    }
  }
  return packages;
}

/** 用 mklink /J 预建 $DSH_HOME/profiles/node_modules 下的全部包链接 */
function ensureJunctions(payloadDir) {
  const nm = path.join(payloadDir, "node_modules");
  const packages = enumeratePackages(nm);
  if (packages.length === 0) {
    crashLog("ensureJunctions: 载荷 node_modules 为空，跳过");
    return;
  }
  const profilesNm = path.join(dshHomeDir(), "profiles", "node_modules");
  fs.mkdirSync(profilesNm, { recursive: true });

  const toCreate = [];
  for (const pkg of packages) {
    const link = path.join(profilesNm, pkg);
    const target = normalizeLinkTarget(path.join(nm, pkg));
    let current = null;
    try {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink()) current = normalizeLinkTarget(fs.readlinkSync(link));
    } catch {
      current = null;
    }
    if (current === target) continue;
    if (current !== null) {
      // 只移除符号链接本身；若是真实目录则不动（留给 dsh 报错）
      try {
        fs.rmdirSync(link);
      } catch {
        try {
          fs.rmSync(link, { recursive: true, force: true });
        } catch {
          /* 留给 dsh heal 处理 */
        }
      }
    }
    fs.mkdirSync(path.dirname(link), { recursive: true });
    toCreate.push({ link, target });
  }

  if (toCreate.length === 0) {
    crashLog(`ensureJunctions: 全部 ${packages.length} 个链接已就位`);
    return;
  }
  crashLog(`ensureJunctions: 需要创建 ${toCreate.length}/${packages.length} 个链接`);
  // 批量执行 mklink /J：写入临时 .bat 再执行，避开 cmd /c 的引号剥离问题
  // （mklink /J 创建的是真 junction，任何用户都无需管理员权限）
  const batPath = path.join(dataDir, "junctions.bat");
  const lines = ["@echo off"];
  for (const { link, target } of toCreate) lines.push(`mklink /J "${link}" "${target}"`);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(batPath, lines.join("\r\n"), "ascii");
    // 不手工加引号：Node 对含空格的路径会自动加引号（cmd 规则 1 保留引号），
    // 手工预引会被 Node 转义成 \" 反而被 cmd 的引号剥离规则破坏
    spawnSync("cmd", ["/d", "/c", batPath], { windowsHide: true, stdio: "ignore", timeout: 120000 });
    fs.rmSync(batPath, { force: true });
  } catch (err) {
    crashLog(`ensureJunctions: 执行失败: ${err.message}`);
  }
  const missing = toCreate.filter(({ link }) => !fs.existsSync(link)).length;
  if (missing > 0) crashLog(`ensureJunctions: ${missing} 个链接仍缺失`);
  else crashLog("ensureJunctions: 全部创建完成");
}

// ---------------------------------------------------------------------------
// 进程管理：端口探测、服务拉起、等待就绪、清理
// ---------------------------------------------------------------------------

function probeFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, BIND_HOST, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function findNodeExecutable() {
  const candidates = [];
  // 首装在线下载的运行时（数据目录，独立于载荷，更新切换不丢失）
  const dlNode = path.join(dataDir, "node", "node.exe");
  if (fs.existsSync(dlNode)) candidates.push(dlNode);
  // 兼容旧版本数据：载荷目录内已复制的 node
  const bundled = path.join(serverPayloadDir(), "node", "node.exe");
  if (fs.existsSync(bundled)) candidates.push(bundled);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["--version"], { windowsHide: true, timeout: 10000, encoding: "utf8" });
      if (r.status === 0 && r.stdout.trim()) return c;
    } catch {
      /* 下一个候选 */
    }
  }
  // 回退：PATH 中的 node
  try {
    const r = spawnSync("where", ["node"], { windowsHide: true, encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) {
      const first = r.stdout.split(/\r?\n/)[0].trim();
      if (first) return first;
    }
  } catch {
    /* 无 PATH node */
  }
  return null;
}

let serverProc = null;
let logStream = null;
const logTail = [];
let quitting = false;
let stopRequested = false; // 主动停服（重启/更新/退出），抑制“服务已停止”弹窗

function logLine(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  logTail.push(entry);
  if (logTail.length > 200) logTail.shift();
  if (logStream) logStream.write(entry + "\n");
}

function startServer(port, payloadDir, nodeExe) {
  stopRequested = false; // 新服务启动后，后续意外退出仍需弹窗提示
  const bin = path.join(
    payloadDir,
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );
  if (!fs.existsSync(bin)) throw new Error(`未找到 dsh 启动脚本：${bin}`);
  fs.mkdirSync(dataDir, { recursive: true });
  logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  logLine(`--- 启动服务 (port=${port}, node=${nodeExe}) ---`);
  const child = spawn(nodeExe, [bin, "web", "--host", BIND_HOST, "--port", String(port)], {
    cwd: payloadDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  serverProc = child;
  const sink = (chunk) => {
    const text = chunk.toString();
    logLine(text.replace(/\n$/, ""));
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  child.on("error", (err) => {
    logLine(`服务进程错误: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    logLine(`服务已退出 (code=${code}, signal=${signal})`);
    serverProc = null;
    if (logStream) {
      logStream.end();
      logStream = null;
    }
    if (!quitting && !stopRequested && mainWindow && !mainWindow.isDestroyed()) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "error",
        title: APP_NAME,
        message: "服务已停止",
        detail: `服务进程意外退出（code=${code}）。\n\n最近的日志：\n${logTail.slice(-15).join("\n")}`,
        buttons: ["重启服务", "退出"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice === 0) restartServer();
      else app.quit();
    }
  });
  return child;
}

async function waitForServer(port, timeoutMs) {
  const url = `http://${BIND_HOST}:${port}/`;
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (!serverProc) throw new Error("服务进程已退出");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res) return url;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, SERVER_READY_POLL_MS));
  }
  throw new Error(
    `等待服务就绪超时（${timeoutMs / 1000}s）：${lastErr ? lastErr.message : "未知错误"}`,
  );
}

function killServer() {
  stopRequested = true; // 主动停止：不弹“服务已停止”
  if (serverProc && serverProc.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 10000,
      });
    } catch {
      /* 进程可能已退出 */
    }
    serverProc = null;
  }
  if (logStream) {
    try {
      logStream.end();
    } catch {
      /* 忽略 */
    }
    logStream = null;
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

let mainWindow = null;
let serverPort = 0;
let booting = false;

/** 崩溃与异常日志（打包模式下无控制台，必须落盘才能排查） */
const CRASH_LOG_PATH = path.join(dataDir, "crash.log");
function crashLog(msg) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(CRASH_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* 忽略 */
  }
}
process.on("uncaughtException", (err) => {
  crashLog(`uncaughtException: ${err.stack || err}`);
});
process.on("unhandledRejection", (reason) => {
  crashLog(`unhandledRejection: ${reason && reason.stack ? reason.stack : String(reason)}`);
});
app.on("render-process-gone", (_event, _wc, details) => {
  crashLog(`render-process-gone: ${JSON.stringify(details)}`);
});
app.on("child-process-gone", (_event, details) => {
  crashLog(`child-process-gone: ${JSON.stringify(details)}`);
});

function setStatus(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents
      .executeJavaScript(`document.getElementById("status").textContent = ${JSON.stringify(text)}`)
      .catch(() => {});
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0f1115",
    title: APP_NAME,
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const icon = path.join(resourceDir(), "..", "build", "icon.png");
  if (fs.existsSync(icon)) mainWindow.setIcon(icon);

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 外链一律丢给系统浏览器
  const ourOrigin = () => `http://${BIND_HOST}:${serverPort}`;
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ourOrigin()) && !url.startsWith("file://")) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadFile(path.join(__dirname, "loading.html"));
}

function buildMenu() {
  const ourUrl = () => `http://${BIND_HOST}:${serverPort}`;
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "重新加载页面",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.webContents.reload(),
        },
        {
          label: "重启服务",
          click: () => restartServer(),
        },
        {
          label: "检查更新…",
          click: () => runUpdateCheck(true),
        },
        {
          label: "下载源",
          submenu: [
            {
              label: "国内镜像源（npmmirror，默认）",
              type: "radio",
              checked: updater.getRegistry() === updater.DEFAULT_REGISTRY,
              click: () => switchRegistry(updater.DEFAULT_REGISTRY),
            },
            {
              label: "官方源（registry.npmjs.org）",
              type: "radio",
              checked: updater.getRegistry() !== updater.DEFAULT_REGISTRY,
              click: () => switchRegistry("https://registry.npmjs.org"),
            },
          ],
        },
        { type: "separator" },
        {
          label: "在系统浏览器中打开",
          click: () => shell.openExternal(ourUrl()),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "打开服务日志",
          click: () => shell.openPath(LOG_PATH),
        },
        {
          label: "关于",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: `关于 ${APP_NAME}`,
              message: `${APP_NAME} v${app.getVersion()}`,
              detail:
                `Electron ${process.versions.electron}\n` +
                `dsh ${currentDshVersion(serverPayloadDir())}\n\n` +
                `服务地址：${ourUrl()}\n数据目录：${serverPayloadDir()}\n` +
                `下载源：${updater.getRegistry()}\n` +
                `日志：${LOG_PATH}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 切换下载源：写配置持久化 + 通知 updater + 重建菜单刷新勾选 */
function switchRegistry(url) {
  updater.setRegistry(url);
  saveAppConfig({ registry: url });
  buildMenu();
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "下载源已切换",
    message: `下载源已切换为：${url}`,
    detail: "将在下次下载/更新时生效（首次运行下载、检查更新）。",
  });
}

// ---------------------------------------------------------------------------
// 启动流程
// ---------------------------------------------------------------------------

async function boot() {
  try {
    if (booting) return;
    booting = true;
    crashLog("boot: begin");
    // 恢复应用配置（下载源等）；环境变量 DSH_DESKTOP_NPM_REGISTRY 优先于配置
    const appCfg = loadAppConfig();
    if (appCfg.registry) updater.setRegistry(appCfg.registry);
    crashLog(`boot: registry=${updater.getRegistry()}`);
    const payloadDir = serverPayloadDir();
    await ensurePayload(setStatus);
    crashLog(`boot: payload=${payloadDir}`);

    // 预建 dsh 模块链接（mklink /J，无需特权），让服务端的 heal 全部 no-op
    ensureJunctions(payloadDir);

    const nodeExe = findNodeExecutable();
    if (!nodeExe) {
      dialog.showErrorBox(
        APP_NAME,
        "未找到 Node.js。\n\n请先安装 Node.js（https://nodejs.org），或把 node.exe 放到应用目录的 resources/node/ 下，然后重新启动。",
      );
      app.quit();
      return;
    }

    serverPort = await probeFreePort();
    crashLog(`boot: port=${serverPort} node=${nodeExe}`);
    setStatus("正在启动服务…");
    startServer(serverPort, payloadDir, nodeExe);
    setStatus("等待服务就绪…");
    crashLog("boot: server spawned, waiting for readiness");
    const url = await waitForServer(serverPort, SERVER_READY_TIMEOUT_MS);
    crashLog(`boot: server ready ${url}`);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadURL(url);
    mainWindow.setTitle(`${APP_NAME} — ${url}`);
    if (process.env.DSH_DESKTOP_SMOKE_FILE) runSmokeCheck(process.env.DSH_DESKTOP_SMOKE_FILE, url);
    // 启动后静默检查更新（可 DSH_DESKTOP_DISABLE_UPDATE_CHECK=1 关闭）
    if (process.env.DSH_DESKTOP_DISABLE_UPDATE_CHECK !== "1") {
      setTimeout(() => {
        runUpdateCheck(false);
      }, 20000);
    }
  } catch (err) {
    const ci = updater.causeInfo(err);
    crashLog(`boot: FAILED ${err.stack || err}${ci ? `\n  底层原因: ${ci}` : ""}`);
    const detail = `${err.message}${ci ? `\n底层原因: ${ci}` : ""}\n\n最近的日志：\n${logTail.slice(-15).join("\n")}`;
    let retry = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      retry =
        dialog.showMessageBoxSync(mainWindow, {
          type: "error",
          title: APP_NAME,
          message: "启动失败",
          detail,
          buttons: ["重试", "退出"],
          defaultId: 0,
          cancelId: 1,
        }) === 0;
    } else {
      dialog.showErrorBox(`${APP_NAME} — 启动失败`, detail);
    }
    if (retry) {
      booting = false;
      boot();
    } else {
      app.exit(1);
    }
  }
}

/** 冒烟检查：页面加载完成后把 DOM 关键状态写入 JSON 文件（仅 DSH_DESKTOP_SMOKE_FILE 设置时启用） */
async function runSmokeCheck(outFile, url) {
  try {
    const wc = mainWindow.webContents;
    wc.once("did-finish-load", async () => {
      try {
        await new Promise((r) => setTimeout(r, 6000)); // 等 SPA 完成首帧渲染
        const info = await wc.executeJavaScript(`(() => {
          const root = document.getElementById("root");
          return {
            title: document.title,
            href: location.href,
            readyState: document.readyState,
            allElements: document.querySelectorAll("*").length,
            shadowHosts: [...document.querySelectorAll("*")].filter((e) => e.shadowRoot).length,
            buttons: [...document.querySelectorAll("button")].slice(0, 8).map((b) => (b.textContent || "").trim().slice(0, 40)),
            headings: [...document.querySelectorAll("h1,h2,h3")].slice(0, 5).map((e) => (e.textContent || "").trim().slice(0, 40)),
            rootHtml: root ? root.innerHTML.slice(0, 500) : "(no #root)",
            hasBoot: typeof window.__DSH_BOOT__ !== "undefined",
          };
        })()`);
        fs.writeFileSync(outFile, JSON.stringify({ url, at: new Date().toISOString(), ...info }, null, 2));
        logLine(`冒烟检查完成: ${JSON.stringify(info)}`);
      } catch (err) {
        fs.writeFileSync(outFile, JSON.stringify({ url, error: String(err) }, null, 2));
      }
    });
  } catch (err) {
    logLine(`冒烟检查设置失败: ${err.message}`);
  }
}

let updating = false;

/** 检查更新并（经用户确认后）下载应用。manual=false 时为启动静默检查。 */
async function runUpdateCheck(manual) {
  if (updating) return;
  updating = true;
  try {
    crashLog("update: 开始检查");
    const testMode = process.env.DSH_DESKTOP_TEST_UPDATE === "1";
    const latest = await updater.getLatestVersion();
    const payloadDir = serverPayloadDir();
    const current = currentDshVersion(payloadDir);
    // 测试模式：假装当前是旧版本，强制走完整更新流程
    const effectiveCurrent = testMode ? "0.1.0-rc.5" : current;
    crashLog(`update: latest=${latest} current=${current} testMode=${testMode}`);
    if (semver.valid(effectiveCurrent) && semver.gte(effectiveCurrent, latest)) {
      if (manual && !testMode && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title: APP_NAME,
          message: "检查更新",
          detail: `当前已是最新版本：${current}`,
        });
      }
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!testMode) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "info",
        title: APP_NAME,
        message: `发现新版本 ${latest}`,
        detail:
          `当前版本：${current}\n\n是否立即下载并应用？\n` +
          `更新内容约 200MB，下载期间界面会显示进度；完成后自动切换并重启服务。`,
        buttons: ["立即更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice !== 0) {
        crashLog("update: 用户选择稍后");
        return;
      }
    }
    crashLog("update: 开始下载更新");
    mainWindow.loadFile(path.join(__dirname, "loading.html"));
    setStatus("正在解析更新依赖…");
    const stageDir = path.join(dataDir, ".update-stage");
    await updater.prepareUpdate(latest, stageDir, (done, total) =>
      setStatus(`正在下载更新包（${done}/${total}）…`),
    );
    setStatus("正在应用更新…");
    await applyUpdate(stageDir, latest);
    if (!testMode && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: APP_NAME,
        message: "更新完成",
        detail: `已更新到 ${latest}，服务已重启。`,
      });
    }
  } catch (err) {
    const ci = updater.causeInfo(err);
    crashLog(`update: FAILED ${err.stack || err}${ci ? `\n  底层原因: ${ci}` : ""}`);
    const detail = `${err.message}${ci ? `\n底层原因: ${ci}` : ""}\n\n最近的日志：\n${logTail.slice(-8).join("\n")}`;
    if (manual && !testMode) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBoxSync(mainWindow, { type: "error", title: APP_NAME, message: "更新失败", detail, buttons: ["确定"] });
      } else {
        dialog.showErrorBox(`${APP_NAME} — 更新失败`, detail);
      }
    }
  } finally {
    updating = false;
  }
}

/** 原子切换载荷目录并重启服务；新载荷启动失败时回滚到旧版 */
async function applyUpdate(stageDir, version) {
  const dst = serverPayloadDir();
  const bak = `${dst}.bak`;
  crashLog(`update: 应用切换 dst=${dst}`);
  // 先停服务（运行中的服务持有文件锁，重命名会失败）
  quitting = false;
  killServer();
  await fs.promises.rm(bak, { recursive: true, force: true });
  if (fs.existsSync(dst)) await fs.promises.rename(dst, bak);
  await fs.promises.rename(stageDir, dst);
  fs.writeFileSync(
    path.join(dst, ".updated.json"),
    JSON.stringify({ version, at: new Date().toISOString() }),
  );
  crashLog("update: 载荷已切换，重启服务");
  ensureJunctions(dst);
  try {
    const nodeExe = findNodeExecutable();
    if (!nodeExe) throw new Error("未找到 Node.js");
    serverPort = await probeFreePort();
    startServer(serverPort, dst, nodeExe);
    const url = await waitForServer(serverPort, SERVER_READY_TIMEOUT_MS);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(url);
      mainWindow.setTitle(`${APP_NAME} — ${url}`);
    }
    if (process.env.DSH_DESKTOP_SMOKE_FILE) runSmokeCheck(process.env.DSH_DESKTOP_SMOKE_FILE, url);
    crashLog("update: 服务重启成功");
    // 成功后清理备份
    await fs.promises.rm(bak, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    crashLog(`update: 新载荷启动失败，回滚: ${err.message}`);
    killServer();
    await fs.promises.rm(dst, { recursive: true, force: true });
    if (fs.existsSync(bak)) await fs.promises.rename(bak, dst);
    ensureJunctions(dst);
    try {
      const nodeExe = findNodeExecutable();
      serverPort = await probeFreePort();
      startServer(serverPort, dst, nodeExe);
      const url = await waitForServer(serverPort, SERVER_READY_TIMEOUT_MS);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(url);
        mainWindow.setTitle(`${APP_NAME} — ${url}`);
      }
      crashLog("update: 回滚完成，旧版服务已恢复");
    } catch (err2) {
      crashLog(`update: 回滚后启动也失败: ${err2.message}`);
    }
    throw new Error(`新版本启动失败，已回滚到 ${currentDshVersion(dst)}：${err.message}`);
  }
}

function restartServer() {
  quitting = false;
  killServer();
  serverPort = 0;
  booting = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, "loading.html"));
  }
  boot();
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.deepseek.dsh-desktop");
    buildMenu();
    createWindow();
    boot();
  });

  app.on("window-all-closed", () => {
    crashLog("lifecycle: window-all-closed");
    app.quit();
  });

  app.on("before-quit", () => {
    crashLog("lifecycle: before-quit");
    quitting = true;
    killServer();
  });

  app.on("will-quit", () => {
    crashLog("lifecycle: will-quit");
    quitting = true;
    killServer();
  });
}
