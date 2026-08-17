# THIRD-PARTY-NOTICES —— 第三方组件许可声明

本仓库（源码）与构建产物（exe/zip）都不包含任何第三方二进制、闭包或依赖代码：
- 仓库只含应用源码、配置与文档；npm 依赖仅以包名+版本号记录于 `package.json` / `package-lock.json`；
- 产物只含 Electron 壳（应用代码 + Electron 运行时），**不内置 Node.js，也不内置 `@deepseek-ai/dsh`**——两者都由应用首次运行时在线下载。

## 构建产物中包含的组件

| 组件 | 位置（产物内） | 许可 | 说明 |
| --- | --- | --- | --- |
| Electron | `LICENSE.electron.txt` | MIT | electron-builder 打包时自动写入 |
| Chromium 及三方组件 | `LICENSES.chromium.html` | BSD-3-Clause 等 | electron-builder 打包时自动写入 |

## 首次运行时由应用下载的组件（不随仓库/产物分发）

| 组件 | 下载源 | 许可 | 说明 |
| --- | --- | --- | --- |
| Node.js 运行时 | nodejs.org 官方发行版（v24.19.0） | MIT | 下载到用户数据目录 `%APPDATA%\dsh-desktop\node`，官方 LICENSE 一并保存（MIT 再分发要求） |
| `@deepseek-ai/dsh`（DeepSeek Harness 服务端） | npm registry | 闭源/专有 | 下载到用户数据目录；**不随仓库或安装包分发** |

> 若你以二进制形式（exe/zip）再分发本应用，请保留产物内的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html` 两份许可文件。
