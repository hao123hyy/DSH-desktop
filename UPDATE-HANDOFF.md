# UPDATE-HANDOFF —— 版本更新功能 · 接手包

> **读者**：一个没有任何上下文的新对话 / 新 agent。
> **任务域**：DSH桌面版 的「检查更新 / 在线更新 dsh 载荷」功能优化。
> **用法**：先读 `PROJECT-OVERVIEW.md`（工程地图）→ 本文件 → `DEV-NOTES.md`（铁律），即可开工。
> **写作时间**：2026-08-14（会话 session-b9dbc94d）。若与代码不符，以代码为准。
> **2026-08-14 追加**：开源化改造后，发布版**不再内置** dsh 载荷（`ensurePayload` 在无内置载荷时首次运行在线下载，同样写 `.updated.json`，与更新流程同语义）；下文「内置载荷」相关描述以 `PROJECT-OVERVIEW.md` 与代码为准。

---

## 0. 一页速览

- 项目是 **DSH桌面版**（Electron 壳 + 内置 dsh 服务端），把 `dsh web` 包成双击即用的 Windows 应用。
- **更新功能已实现并端到端验证过**（2026-08-14）：启动 20 秒后静默查 npm registry → 发现新版弹窗确认 → 纯 Node 依赖解析 + 下载（SHA-512 校验）→ 原子切换载荷 → 重启服务 → 失败自动回滚。
- 更新对象是 **dsh 载荷**（`@deepseek-ai/dsh` 及其 517 个依赖包），**不是** Electron 外壳本身（外壳无更新通道，是后续可选优化）。
- 当前版本：应用 **0.1.0**；内置 dsh **0.1.0-rc.6**（npm latest 也是 rc.6，截至 2026-08-14）。
- 开发环境 `D:\dsh desktop`；正式环境 `D:\DSHDesktop`（发布只走 `publish.bat`，见 DEV-NOTES）。

---

## 1. 更新功能架构（代码地图）

### 1.1 `updater.js` —— 纯函数层（无 Electron 依赖，可独立测试）

| 导出 | 作用 | 关键实现 |
| --- | --- | --- |
| `PKG_NAME` | `@deepseek-ai/dsh` | |
| `REGISTRY` | npm registry，可用 `DSH_DESKTOP_NPM_REGISTRY` 覆盖 | 默认 `https://registry.npmjs.org` |
| `getLatestVersion()` | 查最新版本号 | GET `/<pkg>/latest`，Accept `application/json`（**不能用 abbreviated**，该端点不支持） |
| `resolvePlan(version)` | 解析依赖闭包（不下载） | BFS + semver（`includePrerelease`）+ os/cpu 平台过滤 + optional 跳过 + peerDependencies（optional peer 跳过）+ 冲突时嵌套一层（`requirer/name`） |
| `prepareUpdate(version, stageDir, onProgress)` | 下载完整闭包到暂存目录 | 6 并发 worker；下载 tarball → 校验 `dist.integrity`（sha512/sha1）→ `tar.x`（strip 1）；写 `package.json` 与 `.installed.json` |

注意：解析器对照测试在 `scripts/test-resolver.js`（与内置闭包包名集合对比，期望 517 vs 516 的少量无害差异）。

### 1.2 `main.js` —— 集成层

- **菜单**：文件 → 「检查更新…」→ `runUpdateCheck(true)`。
- **启动静默检查**：`boot()` 成功后 `setTimeout(runUpdateCheck(false), 20000)`；`DSH_DESKTOP_DISABLE_UPDATE_CHECK=1` 可关闭。
- **`runUpdateCheck(manual)`** 流程：
  1. `updating` 防重入；
  2. `latest = updater.getLatestVersion()`；`current = currentDshVersion(payloadDir)`（读载荷内 package.json）；
  3. 测试模式：`DSH_DESKTOP_TEST_UPDATE=1` 时 `effectiveCurrent = "0.1.0-rc.5"`（假装旧版，强制走全流程，且**跳过确认弹窗**）；
  4. `semver.gte(effectiveCurrent, latest)` → 已是最新（manual 时弹「已是最新」）；
  5. 弹窗确认（非测试模式）→ 窗口切到 `loading.html` → `prepareUpdate`（进度经 `setStatus` 显示）→ `applyUpdate`；
  6. 失败：`crashLog` + manual 时弹错误框（带日志尾部）。
- **`applyUpdate(stageDir, version)`** —— 原子切换 + 回滚：
  `killServer()`（抑制弹窗）→ 删旧 `.bak` → `dst → dst.bak` → `stage → dst` → 写 `.updated.json` → `ensureJunctions`（增量）→ 找 node → 起新服务 → 等就绪 → `loadURL` → （有 `DSH_DESKTOP_SMOKE_FILE` 时冒烟复检）→ 成功删 `.bak`；**任何一步失败**：杀服务 → 删新载荷 → `.bak` 还原 → 重启旧版 → 抛错。
- **`ensurePayload()`**（启动时）：**若 `dst/.updated.json` 存在则跳过复制**（在线更新过的载荷优先于内置）——这是更新与「发布新版外壳」共存的关键，勿改。
- **`stopRequested`** 标志：主动停服（重启/更新/退出）不弹「服务已停止」；仅意外崩溃弹。

### 1.3 `loading.html` —— 更新期间的进度 UI

- 只有一个 `#status` 文字节点（`setStatus` 通过 `executeJavaScript` 更新）。
- **优化候选**：进度条 / 百分比 / 下载计数可视化（当前仅文字）。

### 1.4 一次完整更新的数据流

```
用户点「检查更新…」
 → getLatestVersion（npm）
 → 版本比较（semver，含 rc）
 → 确认弹窗
 → loading.html + setStatus("正在解析更新依赖…")
 → resolvePlan：拉取 ~250 个 packument（abbreviated）→ 517 包清单
 → prepareUpdate：并发下载 517 个 tarball（~200MB）→ SHA-512 校验 → 解压到 %APPDATA%\dsh-desktop\.update-stage
 → applyUpdate：停服务 → 原子切换 → .updated.json → junction 增量 → 重启服务（新端口）
 → 窗口 loadURL 回界面；成功后清理 .bak
失败任一环节 → 回滚到 .bak，弹错误框
```

### 1.5 版本与升级语义（重要，勿破坏）

- 更新只影响 **dsh 载荷**（`%APPDATA%\dsh-desktop\server`），不动 Electron 外壳与内置 `resources\dsh-server`。
- `.updated.json` 存在 → 后续启动不覆盖已更新载荷（即使新版外壳内置了更旧载荷）。
- 载荷目录切换对 `~/.dsh` 的 junction 只做**增量修复**（实测 517 包更新后 junction 只补 3 个）。

---

## 2. 当前版本事实（2026-08-14）

| 项 | 值 |
| --- | --- |
| 应用版本 | 0.1.0（`package.json`） |
| 内置 dsh | 0.1.0-rc.6（`resources\dsh-server\node_modules\@deepseek-ai\dsh`） |
| npm latest | 0.1.0-rc.6（**当前无可用更新**——测试更新请用 `DSH_DESKTOP_TEST_UPDATE=1`） |
| Electron | 43.4.0；electron-builder 26.15.3 |
| 内置 Node | v24.19.0（`resources\node\node.exe`，92.8MB；更新不替换 node） |
| 交付物 | `dist\DSHDesktop\`（文件夹版，主推）；`dist\DSH桌面版-0.1.0-win-x64.zip`（252.7MB 分享包） |
| 正式环境 | `D:\DSHDesktop\DSH桌面版.exe`（用户日常双击；只由 `publish.bat` 维护） |

---

## 3. 构建 / 测试 / 验证 SOP

### 3.1 环境变量速查

| 变量 | 作用 |
| --- | --- |
| `DSH_DESKTOP_DATA_DIR` | 应用数据目录（默认 `%APPDATA%\dsh-desktop`）——**测试必须指向隔离目录** |
| `DSH_HOME` | dsh 数据目录（默认 `%USERPROFILE%\.dsh`）——**测试必须指向隔离目录** |
| `DSH_DESKTOP_SERVER_DIR` | 直接指定载荷目录（跳过复制） |
| `DSH_DESKTOP_SMOKE_FILE` | 冒烟结果输出路径（GUI 渲染后写 JSON，含 `hasBoot`） |
| `DSH_DESKTOP_TEST_UPDATE` | `=1` 走完整更新流程（假旧版 + 跳过确认弹窗 + 跳过成功弹窗） |
| `DSH_DESKTOP_DISABLE_UPDATE_CHECK` | `=1` 关闭启动静默检查 |
| `DSH_DESKTOP_NPM_REGISTRY` | 覆盖 npm registry |

### 3.2 测试启动应用（铁律）

```powershell
$env:DSH_DESKTOP_DATA_DIR = "D:\dsh desktop\.smoke-data"
$env:DSH_HOME = "D:\dsh desktop\.smoke-home"
$env:DSH_TELEMETRY_DISABLED = "1"
$env:DSH_DESKTOP_DISABLE_UPDATE_CHECK = "1"
$env:DSH_DESKTOP_SMOKE_FILE = "D:\dsh desktop\.smoke.json"
# 启动 exe（必须用 danger-full-access，否则 spawnSync 管道 EPERM 导致误判崩溃/未找到 Node.js）
& "D:\dsh desktop\dist\DSHDesktop\DSH桌面版.exe"
# 结束后 taskkill /pid <主进程> /T /F
```

- 首次启动会复制 ~344MB 载荷 + 建 516 个 junction（隔离目录），约 1-3 分钟；`.smoke-data/.smoke-home` 可复用加速。
- **启动应用验证必须用完整权限（danger-full-access）**——沙箱下管道捕获 EPERM 会造成假崩溃（0x80000003）与假「未找到 Node.js」。

### 3.3 更新 E2E（真实下载 ~200MB）

```powershell
$env:DSH_DESKTOP_DATA_DIR = "D:\dsh desktop\.runtime-update"
$env:DSH_HOME = "D:\dsh desktop\.dsh-update-test"
$env:DSH_TELEMETRY_DISABLED = "1"
$env:DSH_DESKTOP_TEST_UPDATE = "1"
$env:DSH_DESKTOP_SMOKE_FILE = "..."
& "D:\dsh desktop\dist\win-unpacked\DSH桌面版.exe"
```

- 预期：首启（复制载荷）→ 20s 后自动触发更新 → 解析（~75s）→ 下载（~100s）→ 切换 → 新端口重启 → 冒烟复检。
- 判定：crash.log 出现 `update: 服务重启成功`；smoke.json `hasBoot: true`；载荷版本已变。

### 3.4 打包与发布

- `npm run make` → `dist\win-unpacked` + `dist\DSHDesktop`（make.ps1 已 ASCII 化）。
- `publish.bat`（项目根）→ 发布到 `D:\DSHDesktop`（用户手动跑；含冒烟与回滚）。
- 分享 zip：`tar -a -c -f D:\DSH桌面版-<ver>-win-x64.zip -C D:\ DSHDesktop`（发布脚本第 6 步自动生成，与正式环境同级）。

---

## 4. 已知限制与优化候选（供新对话选题）

1. **进度可视化**：更新期间 `loading.html` 只有文字 `#status`；`prepareUpdate` 已提供 `(done, total)` 回调，加进度条/百分比成本低。
2. **下载可靠性**：无重试、无断点续传、无缓存（每次全量下载 517 个 tarball，~200MB）；单包超时 180s。可考虑失败重试、tarball 缓存复用、多源镜像。
3. **镜像/网络**：默认 npmjs；国内网络可能慢。`DSH_DESKTOP_NPM_REGISTRY` 已可覆盖，可评估默认 npmmirror 或自动降级。
4. **更新检查策略**：启动后固定 20s；静默失败（非 manual 失败只写 crash.log，用户无感知）；无「有新版本」的角标/通知。
5. **外壳自更新**：目前只更新 dsh 载荷；Electron 外壳（0.1.0）无更新通道。若做：注意 portable 自解压壳在本机不可靠的历史（NSIS stub 卡死事故），文件夹版方案更稳。
6. **回滚测试自动化**：`applyUpdate` 回滚逻辑存在但无自动化用例（可构造坏载荷测回滚）。
7. **更新后验证增强**：冒烟只断言 `hasBoot`；可加更细的界面断言（标题/元素数）。
8. **多实例语义**：所有实例共享 `%APPDATA%\dsh-desktop` → 单实例锁 → dev/prod 互斥已隐式成立；更新期间不会有第二个实例竞争。
9. **更新与发布交互**：`publish.bat` 发布新外壳（内置旧载荷）时，`.updated.json` 保证已在线更新的载荷不被覆盖——此行为是特性，勿「修复」。
10. **体积**：闭包 517 包全量下载；`resolvePlan` 已按平台过滤（跳过 linux/mac 专属包与 wasm 备用包）。

---

## 5. 环境事实与调试入口

| 项 | 路径 |
| --- | --- |
| 项目 | `D:\dsh desktop`（main.js / updater.js / loading.html / scripts\） |
| 正式环境 | `D:\DSHDesktop`（**只读，勿动**；发布走 publish.bat） |
| 应用数据/载荷 | `%APPDATA%\dsh-desktop`（`server\` 载荷、`crash.log`、`server.log`） |
| dsh 数据 | `C:\Users\PC5080\.dsh`（sessions / profiles / 凭据） |
| 会话日志 | `C:\Users\PC5080\.dsh\sessions\--D-dsh~0020desktop--\session-*\session.jsonl.zstd`（zstd 多帧拼接；解码与校验方法见 DEV-NOTES「会话日志 seq 断裂」节） |
| dsh 内核源码 | `C:\Users\PC5080\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh`（读代码用） |
| 3080 网页端 | 原 harness（用户手动启动，与桌面端共享 `~/.dsh`；桌面端是其冷读者） |
| 日志 | 应用内菜单「帮助 → 打开服务日志」= `%APPDATA%\dsh-desktop\server.log`；启动异常看同目录 `crash.log` |

---

## 6. 陷阱清单（务必先读）

1. **沙箱 EPERM**：受限环境下 Node `spawnSync/spawn` 管道捕获失败 → 应用内部 `findNodeExecutable` 全挂 → 假「未找到 Node.js」；载荷复制阶段还可能原生崩溃（0x80000003 对话框）。**测试启动应用一律 danger-full-access**。
2. **PS 5.1 编码**：`scripts\*.ps1` 必须保持**纯 ASCII**（中文写字符串会被 GBK 误读、吞引号、语法错误）；读 UTF-8 JSON 用 `Get-Content -Raw -Encoding UTF8`；中文名（productName/进程名/使用说明.txt）一律动态获取。
3. **文件锁**：运行中的实例锁 exe/asar；打包/刷新前先 `Get-Process` 查 `DSH*`。
4. **正式环境**：`D:\DSHDesktop` 只由 `publish.bat` 维护；发布是**用户手动动作**，agent 只指导不代跑。
5. **会话数据**：测试永远用隔离 `DSH_HOME`，别碰真实 `~/.dsh`（会话日志损坏事故见 DEV-NOTES）。
6. **不要对会话日志做整体重编号**（seq 由写入端内存长度决定，重编号会与后续追加脱节——本次事故的教训）。
7. **更新 E2E 真实下载** ~200MB，先确认网络；registry 不可达时 `getLatestVersion` 抛错，静默检查会吞掉（只写 crash.log）。
8. 旧分享 zip 内文件夹名为 `DSH桌面版`，新命令产出 `DSHDesktop`——命名历史遗留，重打 zip 时注意一致性。

---

## 7. 相关文件索引

| 文件 | 内容 |
| --- | --- |
| `updater.js` | 版本检查 / 依赖解析 / 下载校验（纯 Node） |
| `main.js` | 更新集成：菜单、启动检查、applyUpdate 切换与回滚、ensurePayload 防护 |
| `loading.html` | 更新/启动进度页（`#status`） |
| `scripts/test-resolver.js` | 解析器对照测试（517 vs 516） |
| `scripts/make.ps1` / `setup.ps1` / `publish.ps1` | 构建 / 初始化 / 发布（ASCII） |
| `publish.bat` | 用户发布入口 |
| `PROJECT-OVERVIEW.md` | 工程大纲（架构 / 模块 / 数据流 / 关键决策，每次改代码后同步） |
| `DEV-NOTES.md` | 角色分工铁律、沙箱陷阱、会话日志事故、常用命令 |
| `README.md` | 用户视角文档 |
| `dist\DSHDesktop\使用说明.txt` | 随包说明（含「版本更新」章节） |
