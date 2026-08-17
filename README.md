# DSH桌面版 —— DeepSeek Harness 桌面客户端

把 `dsh web` 的浏览器界面封装成一个 Windows 桌面应用：

- 双击即可运行，**无需打开 cmd、无需手动起服务**；
- 应用在首次运行时自动下载 Node.js 运行时与服务端组件，无需任何安装；
- 独立窗口内显示与浏览器完全相同的 Web UI；
- 关闭窗口自动结束服务进程树，不留后台孤儿进程；
- 数据（会话、工作区、凭据、配置）仍然使用你现有的 `%USERPROFILE%\.dsh`，与命令行用法完全互通；
- **服务端组件（`@deepseek-ai/dsh` 闭源闭包）与 Node.js 运行时都不随安装包分发**：首次运行 exe 时应用自动在线下载（闭包约 200MB + Node 约 90MB，显示进度），之后离线可用。

## 目录结构

```
dsh-desktop\
├─ main.js                 Electron 主进程（起服务、探活、窗口、清理、首装下载）
├─ updater.js              更新/下载引擎（纯 Node）：版本检查、依赖解析、下载校验、node 运行时下载
├─ loading.html            启动/下载/更新进度页
├─ resources\dsh-server\   本地服务端闭包（不入库；npm install 自动生成，仅开发模式使用）
├─ scripts\
│  ├─ prepare-payload.js   自动下载服务端闭包到 resources\dsh-server（npm install 自动触发）
│  ├─ setup.ps1            一键初始化（等价于 npm install + 图标生成）
│  ├─ make.ps1             打包（dist\DSHDesktop\ 文件夹版 + 可选 portable）
│  └─ publish.ps1          发布到正式环境（publish.bat 调用）
├─ build\icon.png          应用图标
└─ dist\                  打包输出（DSHDesktop\ 文件夹版 + 可选 portable 单文件）
```

## 从源码构建

```powershell
npm install      # 自动下载服务端闭包到 resources\dsh-server（约 200MB，一次即可）
npm run make     # 打包：dist\DSHDesktop\ 文件夹版 + dist\*-portable.exe
```

> `npm install` 的 postinstall 钩子会自动准备闭包，无需手动跑 `npm run setup`。
> 若只想装依赖跳过下载：`npm install --ignore-scripts`。

## 使用

### 直接使用（推荐：文件夹版）

1. 构建（见上）生成 `dist\DSHDesktop\`；
2. 双击项目根目录 **`publish.bat`**（首次会把应用发布到正式环境 `D:\DSHDesktop`）；
3. **双击 `D:\DSHDesktop\DSH桌面版.exe`**，首次运行自动下载服务端组件（约 200MB，需联网），之后即开即用。

> 说明：文件夹版不带 NSIS 自解压壳，在普通用户权限下启动最可靠。
> （`make.ps1` 也会生成单文件 portable 版，但自解压壳在部分机器/安全软件组合下可能卡死，不作为推荐交付。）

### 开发环境 / 正式环境分离（推荐工作流）

- `D:\dsh desktop` 是**开发环境**：源码、构建、测试都在这里（agent 也只在这里工作）；
- `D:\DSHDesktop` 是**正式环境**：只放打包好的应用，日常使用双击这里的 `DSH桌面版.exe`；
- 开发验证通过后，**由你手动发布**：关闭正式版 → 双击 `publish.bat`（自动检查进程、校验构建、原子替换、冒烟验证，失败自动回滚）；
- 发布成功后脚本会**同步生成干净的分发压缩包** `D:\DSH桌面版-<ver>-win-x64.zip`（与 `D:\DSHDesktop` 同级，内容一致，仅 Electron 壳，不含闭包与 node；生成时自动校验，发现问题会警告）；
- 正式环境目录只由发布脚本维护，开发侧的打包/清理永远不会直接碰到它，运行中的正式版也不会被开发操作锁住。

### 首次启动

- 窗口会立即出现，显示「正在下载服务端组件」进度（闭包约 200MB + Node 运行时约 90MB，取决于网速）；
- 下载完成后自动预建 dsh 模块链接（约 500 个，无需管理员权限）并静默拉起服务；
- 之后每次启动约 5 秒进入界面，离线可用。

### 开发模式运行

```powershell
npm start
```

### 环境变量（可选）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_DESKTOP_DATA_DIR` | `%APPDATA%\dsh-desktop` | 应用数据（日志、服务端载荷缓存） |
| `DSH_DESKTOP_SERVER_DIR` | 数据目录内 | 直接指定服务端载荷目录（跳过下载/复制） |
| `DSH_HOME` | `%USERPROFILE%\.dsh` | dsh 数据目录，透传给服务进程 |
| `DSH_DESKTOP_NPM_REGISTRY` | `https://registry.npmmirror.com` | 载荷下载/更新所用的 npm registry（默认国内镜像源；可设 `https://registry.npmjs.org` 官方源或自建源，**优先于菜单设置**） |
| `DSH_DESKTOP_SYSTEM_PROXY` | 无（自动读系统代理） | 手动指定下载代理（格式同 Windows 代理设置，如 `127.0.0.1:7890` 或 `http=...;https=...`）；仅直连失败时使用 |

### 下载源与代理

- **默认使用国内镜像源（npmmirror）**：`@deepseek-ai/dsh` 闭包与全部依赖包的 tarball 均从镜像站下载（SHA-512 校验与官方一致），国内直连快、无需代理。
- 菜单「文件 → 下载源」可一键切换：**国内镜像源（npmmirror）** / **官方源（registry.npmjs.org）**，选择会保存到 `%APPDATA%\dsh-desktop\config.json`，下次下载/更新生效。
- Node.js 运行时始终从 nodejs.org 官方下载（国内一般可直连），不受下载源影响。
- **直连优先，失败自动走系统代理**：下载请求先直连（自动重试）；全部失败后，若检测到系统代理已开启（或设置了 `DSH_DESKTOP_SYSTEM_PROXY`），自动改走系统代理再试。适用于公司网络/安全软件拦截直连的场景（配合代理工具开「系统代理」即可）。失败弹窗与 `crash.log` 会显示每个阶段的底层原因（如 `ECONNRESET`/`ENOTFOUND`）。

## 常见问题

- **没有 Node.js 也能跑**：首次运行时应用自动下载 Node.js 运行时（约 90MB）；若下载失败则回退到 PATH 中的 node。
- **首次运行需要联网**：服务端组件（约 200MB）与 Node 运行时（约 90MB）首次在线下载；下载完成后离线可用。下载失败可点「重试」。
- **无需管理员权限**：dsh 依赖 `$DSH_HOME/profiles/node_modules` 下的模块链接，应用用 `mklink /J`（真 junction，普通用户即可创建）在启动时预建全部链接，服务端启动即视为已就绪，不依赖 SeCreateSymbolicLinkPrivilege。
- **端口冲突**：每次启动自动探测空闲端口（默认不占用 3080，也不与手动启动的 `dsh web` 冲突）。
- **日志**：菜单「帮助 → 打开服务日志」查看 `%APPDATA%\dsh-desktop\server.log`；启动异常排查看同目录 `crash.log`。
- **关窗即停**：关闭窗口会结束服务进程树（taskkill /T），不留后台进程。
- **不要在 dist 里直接运行旧版 portable 单文件**：其自解压壳（NSIS stub）在普通权限下可能死循环烧 CPU 且不显示窗口（本机已实测），请使用 `dist\DSHDesktop\DSH桌面版.exe`。
