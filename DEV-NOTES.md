# DEV-NOTES —— 开发环境工作记录（给未来的 agent / 协作者）

> 这份文件是「会话中断也能接手」的持久记忆。**每次开始/结束重要工作时更新它。**
>
> **新对话开工顺序**：`AGENTS.md`（harness 自动注入本会话，含同款指引）→ ① 读 `PROJECT-OVERVIEW.md`（工程地图）→ ② 读本文件（铁律与教训）→ ③ 读任务相关 handoff（如 `UPDATE-HANDOFF.md`）。

## 工程大纲维护（每次改代码时，务必执行）

`PROJECT-OVERVIEW.md` 是工程的**活地图**（架构/模块/数据流/关键决策）。改代码时按此清单同步：

- [ ] 新增/删除/重命名了文件或模块？→ 更新「顶层目录职责」「模块地图」
- [ ] 新增功能或改变了数据流？→ 更新「核心数据流」对应流程
- [ ] 有新的技术取舍/踩坑？→ 追加「关键设计决策」
- [ ] 版本号/依赖版本变了？→ 更新「版本与状态快照」
- [ ] 完成以上后，更新文件头的「最后更新」行（时间 + 会话 id + 一句话说明）

**纠偏回路**：新对话开工第一步若发现大纲与代码不符 → **先修正大纲再动手**。大纲只写地图级信息，细节留在代码注释与 handoff，避免大纲膨胀失效。

## 角色分工（铁律）

- `D:\dsh desktop` = **开发环境**。agent 只能在这里工作：改代码、构建、测试。
- `D:\DSHDesktop` = **正式环境**（项目外独立目录，用户日常使用）。**只允许通过 `scripts\publish.ps1` 修改**，agent 一律不得直接增删改其中的任何文件。
- 发布流程（**用户手动执行**，agent 不代跑）：
  1. 用户关闭正在运行的正式版；
  2. 用户双击项目根目录 `publish.bat`（等价于 `powershell -File scripts\publish.ps1`）；
  3. 脚本自动：检查进程 → 校验构建 → 原子替换 → 冒烟验证（失败自动回滚）。
- 用户要求「发布」时，agent 的职责：确保构建产物 `dist\DSHDesktop` 完整（可先跑冒烟）→ **指导用户运行 `publish.bat`**，不要自己操作正式环境目录。

## 脚本编码铁律（2026-08-14 事故）

- **`scripts\*.ps1` 必须保持纯 ASCII**。Windows PowerShell 5.1 按系统 ANSI 代码页（中文系统为 GBK）解析无 BOM 的 .ps1，字符串里的任何非 ASCII 字节都可能把闭合引号吞掉导致语法错误。
- 中文名（productName、进程名、使用说明.txt 等）一律**动态获取**（读 package.json / `-like "DSH*"` / `-Filter *.txt`），不要写死在脚本里。
- 读取 UTF-8 JSON 用 `Get-Content -Raw -Encoding UTF8`。
- 曾踩过的坑：make.ps1 / setup.ps1 原本就是坏的（含中文字符串，PS 5.1 解析报错），2026-08-14 已全部改写为 ASCII 并通过 `Parser::ParseFile` 验证。

## 测试启动桌面端的正确姿势（重要教训）

- 验证打包产物时必须用**隔离数据目录**，不要碰真实数据：
  - `$env:DSH_DESKTOP_DATA_DIR`、`$env:DSH_HOME` 指向项目内临时目录（如 `.smoke-data` / `.smoke-home`）
  - `$env:DSH_DESKTOP_SMOKE_FILE` 指向冒烟输出文件，结束后 `taskkill /pid <主进程> /T /F` 清理
- **沙箱陷阱（2026-08-14 事故）**：在受限沙箱环境中，Node 的 `spawnSync`/`spawn` 管道捕获会 EPERM 失败：
  - `findNodeExecutable` 所有候选失败 → 应用误报「未找到 Node.js」；
  - 载荷复制阶段还可能触发原生崩溃（0x80000003 对话框）；
  - **结论：agent 启动桌面端验证必须用完整权限（danger-full-access）**，否则会把环境问题误判为应用 bug。
- 打包/刷新前检查是否有 `DSH桌面版` 进程在运行（正式版或测试实例都会锁文件，导致删除/覆盖失败）。

## 已知坑：会话日志 seq 断裂（2026-08-14）

- 现象：桌面端（或其他冷读者）加载某会话报 `corrupt session log: seq gap in committed region at line N (expected X, got Y)`；而 3080 网页端正常（它是 live 写入者，用内存事件流，不校验磁盘）。
- 根因：会话 fork（延续）时，存储侧多写了一个 `session/end-seed` 行（seq 与随后的 `agent/inbox/spliced` 重复），live 会话里没有这一行。
- 修复：删除存储日志中那个多余的 `session/end-seed` 行即可（seq 链立即连续；写入端计数器不受影响，后续追加无缝）。
- 教训：**不要对日志做"整体 +1"式重编号**——写入端按内存长度分配 seq 且原样落盘，重编号会与后续追加脱节，制造新的重复。
- 校验方法：解码 zstd（多帧拼接，`node:zlib` 的 `zstdDecompressSync` 逐帧解）→ 逐行展开（打包行按 `seq0` + `data.texts/args.length` 展开）→ 断言每事件 `seq === 序号`。

## 当前状态（2026-08-14）

- 应用版本 **0.1.0**；内置 dsh 载荷 **0.1.0-rc.6**（`resources\dsh-server`）
- 已实现：**自动更新**（`updater.js` + `main.js` 集成；菜单「文件 → 检查更新…」；启动 20 秒后静默检查；下载→切换→重启全程自动；失败自动回滚；`DSH_DESKTOP_DISABLE_UPDATE_CHECK=1` 可关闭）
- 已修复：主动停服（重启/更新/退出）不再误弹「服务已停止」
- 交付物：`dist\DSH桌面版-0.1.0-win-x64.zip`（252.7MB，解压往返已验证）
- 正式环境：`D:\DSHDesktop`（由 `publish.bat` 维护；`dist\DSHDesktop` 是开发侧同名交付文件夹）
- 注意：`dist\DSH桌面版-0.1.0-win-x64 - 副本.zip` 是副本，勿混淆

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖；postinstall 自动下载服务端闭包到 `resources\dsh-server`（约 200MB） |
| `npm run make` | 打包（产出 `dist\win-unpacked` + `dist\DSHDesktop`，**仅 Electron 壳，不含闭包与 node**） |
| `node scripts/prepare-payload.js [--force]` | 手动下载/刷新本地服务端闭包（幂等，开发模式用） |
| `npm run setup` | 一键初始化（等价 npm install + 图标，兼容旧习惯） |
| `publish.bat` | 用户手动发布到正式环境（校验 + 冒烟 + 失败回滚；成功后同步生成干净分享 zip 到 `D:\`） |
| `powershell -File scripts\publish.ps1 -SkipVerify` | 只替换、不冒烟 |
| 重打分享 zip | `tar -a -c -f D:\DSH桌面版-<ver>-win-x64.zip -C D:\ DSHDesktop` |
| `npm start` | 开发模式（`app.isPackaged=false`，直接用 `resources\dsh-server`，node 走 PATH） |
| `DSH_DESKTOP_TEST_UPDATE=1` 启动 | 测试更新流程（走完整下载→切换→重启，约 200MB） |
| `scripts/test-resolver.js` | 更新依赖解析器对照测试 |
| `UPDATE-HANDOFF.md` | 版本更新功能的完整接手包（新对话先读这个） |
| `PROJECT-OVERVIEW.md` | 工程大纲（架构/模块/数据流/关键决策，每次改代码后同步） |

## 开源化要点（2026-08-14 改造）

- **`resources/` 不入库**（.gitignore）：仓库不含 `@deepseek-ai/dsh` 闭源闭包；
- **exe 只含 Electron 壳**：`package.json` 无 extraResources；`afterPack.js`、`prepare-node.js` 已删除；
- **首装在线下载一切**：`main.js` 的 `ensurePayload` 在无内置载荷时调 `updater.prepareUpdate` 下载闭包、`updater.downloadNodeRuntime` 下载 Node 运行时（v24.19.0 + 官方 LICENSE）到 `dataDir\node`（**独立于载荷目录**，更新切换载荷不丢失）；失败回退 PATH node；
- **开发/构建全自动**：postinstall → `prepare-payload.js`（开发闭包）；开发模式 node 走 PATH；
- GitHub Actions：`.github/workflows/build-release.yml`（tag `v*` 或手动触发），runner 上 `npm install --ignore-scripts` 跳过闭包下载；
- 首次运行在线下载失败 → boot 捕获 → 「启动失败」对话框（重试/退出），详情含日志尾巴；
- **发布即出干净 zip**：`publish.ps1` 第 6 步把已发布的 `D:\DSHDesktop` 打成 `D:\DSH桌面版-<ver>-win-x64.zip`（与正式环境同级），并用 `tar -tf` 校验 zip 内无 `dsh-server` / `resources\node`（防闭包/运行时被打包）；校验发现异常仅警告不中断（发布已成功）。

## 结构速览

```
D:\dsh desktop\
├─ main.js / updater.js / loading.html   应用主进程与更新/首装下载逻辑
├─ resources\dsh-server\                 本地服务端闭包（不入库，postinstall 自动生成，仅开发模式）
├─ scripts\  setup.ps1 / make.ps1 / publish.ps1 / prepare-payload.js / icon.ps1 / test-resolver.js
├─ .github\workflows\build-release.yml   GitHub Actions 自动打包 + Release
├─ publish.bat                            用户发布入口
└─ dist\  win-unpacked（构建原始输出）/ DSHDesktop（交付文件夹）/ zip
```
