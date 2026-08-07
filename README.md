# OrbitSSH

> 面向本地 AI 客户端的人机共驾 SSH 工作台。

OrbitSSH 是一个 Windows 优先的本地桌面应用。它把可复用的 SSH 会话、图形化终端、文件传输和 MCP 工具接口放进同一套安全边界中，让用户与 Codex 能在同一台远程服务器上协作，而不是各自维护一条互相看不见的连接。

## 为什么是 OrbitSSH

- **共享会话**：桌面端和本地 AI 客户端通过同一个 Runtime 使用同一逻辑会话，保留当前目录、终端上下文、执行顺序和历史轨迹。
- **人机共驾**：用户可以继续直接操作终端；Codex 的命令与用户命令进入同一队列，按先后顺序执行。
- **三档授权**：支持“每次询问”“自动只读”“信任会话”。高危操作不会因信任会话而被静默放行。
- **完全接管**：用户可随时暂停 Codex 的后续操作；已在运行的命令不会被静默中断。
- **可见、可追溯**：审批、排队、执行中、成功、失败和高危操作都记录到本地协作轨迹中。
- **文件边界**：上传和下载必须显式配置本地与远程允许目录，路径逃逸和符号链接逃逸会被拒绝。

## 功能概览

| 区域 | 能力 |
| --- | --- |
| 服务器星图 | 保存、搜索、导入和导出 SSH 连接配置 |
| 主会话 | 真实 SSH 终端、当前目录与 Shell 提示符、用户和 Codex 的共享命令队列 |
| 共驾轨迹 | 操作来源、授权状态、执行结果、高危提示与历史记录 |
| 文件舱 | 浏览远程目录、拖入上传、选择本地文件上传、下载与进度展示 |
| MCP 接口 | 供本地 Codex 调用连接、健康检查、命令执行和受限文件传输 |

## 安全设计

OrbitSSH 的安全控制由 Runtime 统一执行，桌面界面和 MCP 都不能绕过它。

- 首次连接或主机指纹变化时，必须在桌面端核对并确认 SSH 主机指纹。
- 密码和私钥口令保存在 Windows 凭据管理器，不写入连接配置。
- 命令历史、输出和错误会对常见密码、Token、Cookie、Bearer 凭据和私钥内容进行脱敏。
- `auto_readonly` 仅放行明确的单条只读命令和下载；含管道、重定向、命令替换或连接符的复杂命令默认不放行。
- 信任会话中的高危命令仍须逐项审批，不能被自动执行。
- 桌面客户端关闭后，可以选择保留 Runtime 与会话；没有客户端可审批时，高危操作会等待或超时拒绝。

详细设计见：[人机共驾架构方案](docs/orbitssh-human-ai-codriving-architecture.md)。

## 快速开始

### 直接使用 Windows 安装包

从 Release 下载并安装 `OrbitSSH-Setup-<version>-x64.exe`，然后在应用中创建 SSH 连接配置。

连接配置、会话历史与主机信任数据默认保存在：

```text
%APPDATA%\AI SSH
```

覆盖安装和卸载不会主动删除这个数据目录。SQLite 使用 WAL 模式时，同目录中的 `ai-ssh.sqlite-wal` 和 `ai-ssh.sqlite-shm` 也是数据库的一部分，请不要单独删除。

### 从源码运行

环境要求：Windows、Node.js 22 或更高版本，以及可用于编译 Electron 原生依赖的 Windows 开发环境。

```powershell
npm.cmd install
npm.cmd run dev
```

构建安装包：

```powershell
npm.cmd run build:windows
```

该命令会构建 Windows 安装包，并执行打包应用、Runtime、SQLite 与 MCP 冒烟验证。

## 接入 Codex MCP

安装版自带 MCP 服务和 Runtime，不依赖保留源码目录或额外安装 Node.js。安装到默认位置后，在 PowerShell 中执行：

```powershell
codex mcp add orbitssh --env ELECTRON_RUN_AS_NODE=1 -- `
  "$env:LOCALAPPDATA\Programs\OrbitSSH\OrbitSSH.exe" `
  "$env:LOCALAPPDATA\Programs\OrbitSSH\resources\mcp\server.js"
```

随后完全退出并重新打开 Codex，再执行 `codex mcp list` 确认服务已注册。

MCP 提供以下工具：

- `list_connection_profiles`：读取不含凭据的连接配置。
- `open_connection_session`：打开或复用持久 SSH 会话。
- `get_session_health`：查看会话健康状态。
- `run_remote_command`：向共享会话提交远程命令。
- `upload_file` / `download_file`：在已配置允许目录内传输文件。
- `close_connection_session`：显式关闭会话。

完整说明见：[Codex MCP 本地接入指南](docs/codex-mcp-setup.md)。

## 授权模式

| 模式 | Codex 可以做什么 | 用户终端 |
| --- | --- | --- |
| 每次询问 | 每项操作都等待批准 | 始终可用 |
| 自动只读 | 自动执行明确只读命令；写操作和上传等待批准 | 始终可用 |
| 信任会话 | 自动执行普通操作；高危操作仍等待批准 | 始终可用 |

“完全接管”是独立控制项，不是第四档授权模式。开启后只阻止 Codex 提交新的或尚未开始的操作，用户仍可继续使用终端。

## 数据与迁移

旧版 JSON 配置和历史会在首次升级时以事务方式迁移到 SQLite，并保留只读 `.bak` 备份。迁移、备份或校验失败时，程序不会删除原始数据或切换到不完整数据库。

连接配置可以导入和导出。导出时可由用户决定是否包含密码和私钥；包含敏感信息的导出文件应按凭据文件妥善保管。

## 当前范围

本项目当前聚焦 Windows 本地桌面端、SSH 会话、共享终端、受限文件传输和 Codex MCP 协作。端口转发暂不在首个版本范围内。

## 开源许可与署名

OrbitSSH 计划采用 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)。该协议允许使用、修改、分发和商业使用，但分发副本或衍生作品时必须保留原有版权、许可证和 `NOTICE` 中的署名信息。

发布到 GitHub 前，请在仓库根目录加入完整的 `LICENSE` 与 `NOTICE` 文件，并在 `NOTICE` 中写入希望他人保留的作者、组织、项目地址和版权信息。若希望闭源商业授权或额外的品牌展示要求，请另行提供商业授权条款；不要把额外限制混入 Apache-2.0 正文。

## 贡献

欢迎提交 Issue、功能建议与 Pull Request。涉及安全策略、授权逻辑、主机信任、凭据、命令脱敏和文件路径边界的改动，请同时补充对应测试。

提交前建议运行：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build:code
```

## 致谢

OrbitSSH 基于 Electron、React、xterm.js、ssh2、SQLite 和 Model Context Protocol SDK 构建。
