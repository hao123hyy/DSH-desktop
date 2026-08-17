# AGENTS.md —— DSH桌面版 项目开工指引（自动加载）

> 本文件由 dsh 在每个新会话的第一次请求前**自动注入**（无需用户提醒）。内容刻意保持精简：只放「入场路径」与「红线」。详细地图见 PROJECT-OVERVIEW.md，教训见 DEV-NOTES.md。

## 1. 开工必读（按顺序）

1. `PROJECT-OVERVIEW.md` —— 工程地图（项目是什么 / 模块职责 / 核心数据流 / 关键设计决策）
2. `DEV-NOTES.md` —— 铁律与事故教训（角色分工 / 编码铁律 / 沙箱陷阱 / 已知坑）
3. 任务相关的 handoff（如 `UPDATE-HANDOFF.md`），若用户任务涉及对应领域

**读完再动手。** 若发现 `PROJECT-OVERVIEW.md` 与代码不符 → **先修正大纲再继续**。

## 2. 红线（违反会出事故）

- **正式环境 `D:\DSHDesktop` 只读**：只由用户手动运行 `publish.bat` 维护（原子替换+冒烟+回滚）；agent 不得增删改其中的任何文件，也不得代跑发布。
- 开发环境 = `D:\dsh desktop`。改代码/打包/刷新前先检查没有 `DSH*` 进程在运行（运行中的实例会锁 exe/asar，导致删除/覆盖失败）。
- **测试启动桌面端必须用隔离数据目录**：`DSH_DESKTOP_DATA_DIR` / `DSH_HOME` 指向项目内临时目录（如 `.smoke-data` / `.smoke-home`），不要碰真实 `%APPDATA%\dsh-desktop` 与 `~/.dsh`。
- **沙箱环境（受限令牌）下启动应用会假崩溃/假报错**（管道 EPERM → 「未找到 Node.js」/ 0x80000003）：验证桌面端必须用完整权限（danger-full-access）。
- `scripts\*.ps1` 保持**纯 ASCII**（PS 5.1 按 GBK 解析会吞引号）；中文名（productName/进程名/使用说明.txt）动态获取；读 UTF-8 JSON 用 `Get-Content -Raw -Encoding UTF8`。
- 会话数据（`~/.dsh/sessions`）是用户真实数据：测试一律隔离，不直接修改（日志损坏的修复方法见 DEV-NOTES）。

## 3. 维护义务

- 每次改完代码，按 `DEV-NOTES.md` → 「工程大纲维护」清单同步 `PROJECT-OVERVIEW.md`（文件结构 / 数据流 / 关键决策 / 版本快照 / 最后更新戳）。
- 本文件保持精简（它被注入每个会话，占用恒定 token 预算），只放地图指针与红线；细节一律下沉到 PROJECT-OVERVIEW / DEV-NOTES / handoff。
