# PROJECT-OVERVIEW —— DSH桌面版 工程大纲（活地图）

> **本文件是工程的「地图」**：架构、模块职责、数据流、关键决策。只写地图级信息，细节在各文件注释与 handoff 文档。
> **维护契约**：见 `DEV-NOTES.md` → 「工程大纲维护」节。发现与代码不符 → 先修本文再动手。
> **最后更新**：2026-08-17 · 应用 v0.1.0 · 内置 dsh 0.1.0-rc.6 · **开源化改造：exe 不再携带闭源闭包，首装在线下载** · **下载源默认国内镜像（npmmirror），菜单可切官方源**

---

## 1. 项目是什么（一页速览）

**DSH桌面版**：把 `dsh web` 的浏览器界面封装成 Windows 桌面应用（Electron 壳）。

- 双击即用：无命令行、无控制台窗口；独立窗口显示与浏览器完全相同的 Web UI；关窗即停服务（taskkill 树杀，无孤儿进程）
- **在线首装一切**：Node.js 运行时与服务端载荷（`@deepseek-ai/dsh` + 517 个依赖包）**都不随安装包分发**，首次运行 exe 时在线下载（约 290MB，复用 updater 下载引擎），之后离线可用
- **数据互通**：会话/工作区/凭据共用 `%USERPROFILE%\.dsh`，与命令行用法完全互通
- **在线更新**：启动后静默检查 npm registry，一键更新 dsh 载荷（自动下载→切换→重启，失败回滚）
- 交付形态：文件夹版（主推）`dist\DSHDesktop\`；正式环境 `D:\DSHDesktop`（独立于开发环境）

## 2. 顶层目录职责

```
D:\dsh desktop\
├─ main.js                  Electron 主进程（~830 行）：起服务、探活、窗口、菜单、更新集成
├─ updater.js               更新引擎（~228 行，纯 Node）：版本检查、依赖解析、下载校验
├─ loading.html             启动/更新进度页（spinner + #status 文字）
├─ package.json             应用元数据 + electron-builder 打包配置（files/extraResources/win）
├─ publish.bat              用户发布入口（双击 → scripts\publish.ps1）
├─ AGENTS.md                harness 自动注入的开工指引（精简：入场顺序 + 红线；勿膨胀）
├─ DEV-NOTES.md             铁律与事故教训（agent 必读）
├─ PROJECT-OVERVIEW.md      本文件（工程地图）
├─ UPDATE-HANDOFF.md        版本更新功能接手包（任务型 handoff）
├─ README.md                用户视角文档
├─ resources\
│  └─ dsh-server\           @deepseek-ai/dsh 闭包（**不入库**；仅开发模式用，npm install 自动准备）
├─ scripts\
│  ├─ setup.ps1             一键初始化：npm install + 图标生成
│  ├─ make.ps1              打包：electron-builder --win dir portable → DSHDesktop
│  ├─ publish.ps1           发布到正式环境：查进程→校验→原子替换→冒烟→回滚
│  ├─ prepare-payload.js    自动下载服务端闭包到 resources\dsh-server（postinstall 钩子，幂等）
│  ├─ icon.ps1              生成 build\icon.png
│  └─ test-resolver.js      updater 依赖解析器对照测试（517 vs 516）
├─ build\icon.png           应用图标
├─ .github\workflows\       build-release.yml：GitHub Actions 自动打包 + Release（tag v* / 手动）
├─ dist\                    构建输出：win-unpacked（原始）/ DSHDesktop（交付文件夹）/ zip
└─ .smoke-data .smoke-home  冒烟测试的隔离数据目录（可复用加速）
```

## 3. 模块地图

### 3.1 `main.js` —— Electron 主进程

| 区域 | 关键函数 | 职责 |
| --- | --- | --- |
| 路径解析 | `resourceDir()` / `serverPayloadDir()` / `dshHomeDir()` | 打包态 vs 开发态的资源路径；载荷目录 = env > 数据目录稳定副本 > 项目内副本 |
| 载荷准备 | `ensurePayload(updateStatus)` | 打包态：有内置载荷 → 复制到 `%APPDATA%\dsh-desktop\server`（带进度）；**无内置载荷（开源版）→ 首次运行在线下载完整闭包 + Node 运行时**（updater.prepareUpdate / downloadNodeRuntime → 原子切换 → 写 `.updated.json`，与在线更新同语义）；`.updated.json` 存在则跳过 |
| 链接引导 | `ensureJunctions(payloadDir)` | 用 `mklink /J`（真 junction，免管理员权限）预建 `~/.dsh/profiles/node_modules` 的全部包链接，使服务端 heal 全部 no-op；增量维护 |
| 服务进程 | `probeFreePort` / `findNodeExecutable` / `startServer` / `waitForServer` / `killServer` | 随机空闲端口；内置 node 优先；spawn `dsh web --host 127.0.0.1 --port N`（stdout/stderr 落 server.log）；fetch 轮询就绪；`taskkill /T` 树杀 |
| 窗口菜单 | `createWindow` / `buildMenu` | 外链丢系统浏览器；菜单：文件（重载/重启服务/检查更新…/下载源切换/系统浏览器/退出）、视图、帮助（日志/关于） |
| 应用配置 | `loadAppConfig` / `saveAppConfig` / `switchRegistry` | `%APPDATA%\dsh-desktop\config.json`（目前只有下载源）；boot 时恢复 → `updater.setRegistry`；菜单「下载源」radio 切换并持久化 |
| 启动流程 | `boot()` | 见「核心数据流·启动」 |
| 更新 | `runUpdateCheck(manual)` / `applyUpdate(stageDir, version)` | 见「核心数据流·更新」 |
| 冒烟 | `runSmokeCheck(outFile, url)` | `DSH_DESKTOP_SMOKE_FILE` 时把 DOM 状态（hasBoot/标题/元素数）写 JSON |
| 诊断 | `crashLog()` | 一切异常（uncaughtException/unhandledRejection/进程退出）落盘 `crash.log`（打包态无控制台，必须落盘） |
| 生命周期 | 单实例锁 / window-all-closed→quit / before-quit→killServer | 同 userData 全局唯一实例；关窗即停 |

### 3.2 `updater.js` —— 更新引擎（纯 Node，无 Electron 依赖）

- `getLatestVersion()`：查 npm registry `/<pkg>/latest`（Accept 必须 `application/json`，该端点不支持 abbreviated）
- `setRegistry()` / `getRegistry()`：下载源运行时切换/查询；**默认国内镜像 `https://registry.npmmirror.com`**，环境变量 `DSH_DESKTOP_NPM_REGISTRY` 最高优先级（配置/菜单不能覆盖）
- `fetchWithRetry()` / `causeInfo()`：**直连优先**，网络请求自动重试（指数退避；仅网络层错误重试，HTTP 4xx 不重试）；**直连全部失败后自动改走系统代理再试一轮**（读注册表 `HKCU\...\Internet Settings` 的 ProxyEnable/ProxyServer，或环境变量 `DSH_DESKTOP_SYSTEM_PROXY` 手动指定；undici ProxyAgent 经 dispatcher 注入，不影响主进程其他 fetch）；失败错误带**完整 URL + 直连原因 + 代理尝试结果**（undici `err.cause`，如 ECONNRESET/ENOTFOUND），根治「TypeError: fetch failed」无信息盲区（事故：同事机器 curl 全通但应用 4 次 boot 全失败，开 TUN 也无效——进程级拦截，旧日志查不到原因）
- `resolvePlan(version)`：BFS 解析依赖闭包——semver（含 rc）+ os/cpu 平台过滤 + optional 跳过 + optional-peer 跳过 + 冲突嵌套一层
- `prepareUpdate(version, stageDir, onProgress)`：6 并发下载 tarball → SHA-512 完整性校验 → `tar.x` 解压 → 写 `.installed.json`；返回包数（~517）
- `downloadNodeRuntime(destDir, onProgress)`：从 nodejs.org 下载官方 Node 运行时（v24.19.0，zip 解出 node.exe + 官方 LICENSE）

### 3.3 `loading.html` —— 进度页

- 纯静态页：spinner + `#status` 文字；主进程用 `executeJavaScript` 更新
- 用于：首启载荷复制进度、更新下载/应用进度

### 3.4 `scripts/` —— 构建发布链

- `setup.ps1` → `make.ps1`（build）→ `publish.ps1`（release，用户手动）
- `prepare-payload.js`（postinstall）与 `prepare-node.js`（make 前）保证「仓库不含闭包也能开箱即用」：克隆 → `npm install` → `npm run make` 全自动
- 全部 ps1 **纯 ASCII**（PS 5.1 编码铁律，见 DEV-NOTES）

## 4. 核心数据流

### 4.1 启动流程（boot）

```
createWindow（立即显示 loading.html）
 → boot(): ensurePayload（内置载荷则复制；**无内置则在线下载闭包 + Node 运行时，带进度**；有 .updated.json 则跳过）
 → ensureJunctions（增量建 ~516 个链接）
 → findNodeExecutable（数据目录 node 优先，回退 PATH）
 → probeFreePort → startServer（spawn dsh web）→ waitForServer（fetch 轮询）
 → mainWindow.loadURL(服务地址) → 标题改为「DSH桌面版 — http://127.0.0.1:PORT」
 → 20 秒后静默 runUpdateCheck(false)（DSH_DESKTOP_DISABLE_UPDATE_CHECK=1 关闭）
```

### 4.2 更新流程

```
检查版本（npm）→ 比较（semver，含 rc）→ 确认弹窗 → loading.html
 → resolvePlan（~250 个 packument，~75s）→ prepareUpdate（下载 517 包 ~200MB，SHA-512 校验）
 → applyUpdate: killServer → dst→.bak → stage→dst → 写 .updated.json
   → ensureJunctions 增量 → 新服务新端口 → 就绪 → loadURL → 成功删 .bak
 → 任一步失败: 杀服务 → 还原 .bak → 重启旧版 → 报错
```

### 4.3 发布流程（用户手动，agent 不代跑）

```
关闭正式版 → 双击 publish.bat
 → 查 DSH* 进程 → 校验 dist\DSHDesktop 完整 → 复制到 D:\DSHDesktop.new
 → 旧目录→.bak → .new→正式版 → 冒烟验证（隔离目录启动 + hasBoot）→ 失败回滚 → 完成
 → 成功后第 6 步：tar 打包 D:\DSHDesktop → D:\DSH桌面版-<ver>-win-x64.zip，并校验 zip 内无闭包/node
```

### 4.4 数据落盘位置

| 数据 | 位置 |
| --- | --- |
| 应用数据/载荷副本/日志 | `%APPDATA%\dsh-desktop`（server 载荷、crash.log、server.log） |
| dsh 数据（会话/工作区/凭据） | `%USERPROFILE%\.dsh` |
| 会话日志 | `~/.dsh/sessions\<project>\<session-id>\session.jsonl.zstd` |
| 正式环境 | `D:\DSHDesktop` |

## 5. 关键设计决策（为什么是这样）

| 决策 | 原因（事故/教训） |
| --- | --- |
| 文件夹版交付，不用 portable 单文件 | NSIS 自解压壳在普通权限下卡死/崩溃（本机实测事故） |
| 开发/正式环境分离，发布由用户手动执行 | 运行中实例锁文件导致刷新半途而废、交付物残缺（事故） |
| ps1 脚本纯 ASCII | PS 5.1 按 GBK 解析中文导致语法错误、吞引号（事故） |
| 载荷异步复制 + 进度显示 | 首启复制期间无窗口的空白期问题 |
| junction 预建（mklink /J） | 免 SeCreateSymbolicLinkPrivilege，普通用户可用 |
| 更新只动 dsh 载荷；`.updated.json` 防内置覆盖 | 在线更新与「发布新版外壳携带旧载荷」共存的关键语义 |
| **exe 不携带闭源闭包与 Node 运行时，全部首装在线下载** | GitHub 公开仓库/Release 不得再分发 `@deepseek-ai/dsh` 闭源包；Node 运行时（MIT）也改为运行时下载，产物只含 Electron 壳，免去二进制许可文件管理；node 存 `dataDir\node`（独立于载荷目录，更新切换不丢失） |
| **下载源默认国内镜像 npmmirror + 菜单切换 + 环境变量优先** | 国内直连官方源慢/失败是纯壳首装最大痛点；镜像上 `@deepseek-ai/dsh` 的 tarball 与 SHA-512 integrity 与官方完全一致（已实测），解析/校验逻辑不受影响；`DSH_DESKTOP_NPM_REGISTRY` 环境变量 > 配置（config.json，菜单切换写入）> 默认镜像 |
| **下载走代理：直连优先，失败自动走系统代理** | 用户开「系统代理」后 Windows 只写 WinINET 注册表，undici 不读（实测）；实现为：直连（自动重试）→ 全部失败且检测到系统代理开启 → 经 undici ProxyAgent 走系统代理再试，可绕开安全软件对 Electron 直连的进程级拦截（同事机器事故的兜底通道）；环境变量 `DSH_DESKTOP_SYSTEM_PROXY` 可手动指定 |
| userData 统一 → 单实例锁 | 多实例（dev/prod/测试）天然互斥，测试实例用隔离 DATA_DIR 可并行 |
| agent 测试启动应用必须完整权限 | 沙箱 EPERM 导致假崩溃/假「未找到 Node.js」（事故，详见 DEV-NOTES） |

## 6. 版本与状态快照（2026-08-14）

| 项 | 值 |
| --- | --- |
| 应用版本 | 0.1.0 |
| 内置 / npm 最新 dsh | 0.1.0-rc.6（当前无可用更新） |
| Electron / builder | 43.4.0 / 26.15.3 |
| 内置 Node | v24.19.0 |
| 已实现功能 | 自动更新（检查/下载/切换/回滚）、首装在线下载（闭包 + Node）、下载源切换（默认国内镜像 npmmirror，菜单/环境变量）、文件夹版交付、开发/正式分离、冒烟验证 |
| 交付物 | `dist\DSHDesktop\`（仅 Electron 壳，**不含闭包与 node**）；发布时同步生成 `D:\DSH桌面版-<ver>-win-x64.zip` |

## 7. 常用命令

见 `DEV-NOTES.md` → 「常用命令」（setup / make / publish.bat / 冒烟 / 更新 E2E / zip）。
