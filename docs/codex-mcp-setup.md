# Codex MCP 本地接入指南

本指南将已安装的 OrbitSSH MCP 服务接入 Codex。安装版已经自带 MCP 与 Runtime，不需要保留源码目录，也不依赖系统单独安装 Node.js。

## 接入前准备

先安装 `OrbitSSH-Setup-0.1.0-x64.exe`。默认安装目录通常为：

```text
%LOCALAPPDATA%\Programs\OrbitSSH
```

如果安装时选择了其他目录，请在下面的命令中替换安装路径。OrbitSSH 的服务器配置、历史和主机信任不放在安装目录，而是继续保存在兼容数据目录：

```text
%APPDATA%\AI SSH
```

安装、覆盖升级和卸载都不会主动删除这个数据目录。

## 注册与检查

关闭 OrbitSSH 中不再需要的会话后，在 PowerShell 中执行以下命令。显式设置 `CODEX_HOME` 可避免管理员进程把配置写入其他 Windows 用户：

```powershell
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
$orbitssh = Join-Path $env:LOCALAPPDATA 'Programs\OrbitSSH'
codex mcp add orbitssh --env ELECTRON_RUN_AS_NODE=1 -- `
  (Join-Path $orbitssh 'OrbitSSH.exe') `
  (Join-Path $orbitssh 'resources\mcp\server.js')
```

随后检查注册结果和当前可用的 MCP 服务：

```powershell
codex mcp get orbitssh
codex mcp list
```

注册成功后完全退出并重新打开 Codex；已经打开的任务不会热加载新 MCP。若使用了自定义安装目录，只需修改 `$orbitssh` 的值。

如果需要修复路径，先执行 `codex mcp remove orbitssh`，再重新运行上面的注册命令并检查。卸载 OrbitSSH 前可先执行 `codex mcp remove orbitssh`，避免 Codex 保留已经失效的启动路径。

## 开发目录接入

只有开发和调试源码时才使用下面的方式：

```powershell
cd D:\Code\ai-ssh
npm.cmd run build
codex mcp add orbitssh -- node D:\Code\ai-ssh\dist\mcp\server.js
```

不要将 `src/mcp/server.ts`、临时目录或旧工作树路径作为生产入口。

## 可用工具与审批

服务提供以下七个工具：

- `list_connection_profiles`：列出已保存的连接配置，不包含秘密。
- `open_connection_session`：打开或复用持久 SSH 会话。
- `get_session_health`：查询会话的 connected、degraded 或 disconnected 状态。
- `run_remote_command`：在已有会话中执行远程命令。
- `upload_file`：将本地文件上传到远程路径。
- `download_file`：将远程文件下载到本地路径。
- `close_connection_session`：显式关闭持久 SSH 会话。

`list_connection_profiles` 和 `get_session_health` 是只读发现工具。打开会话、执行命令、上传、下载和关闭会话都应保留 Codex 的人工审批。请在 Codex 的 MCP 工具审批设置中分别配置这些工具；服务端不会把这些具有影响的操作自动提升为无需审批。

## 授权等级与服务端边界

会话在 `open_connection_session` 时可选择 `ask_every_time`、`auto_readonly` 或 `trusted_session` 授权等级。

- `ask_every_time`：依赖 Codex 对每一次工具调用的审批；服务端允许请求继续到 SSH 层。
- `auto_readonly`：服务端只放行明确识别为单条只读命令，以及 `download_file` 下载。它拒绝写操作、无法确认只读的命令、包含换行、管道、重定向、命令替换或连接符等复合 Shell 语法的命令，并拒绝 `upload_file` 上传。
- `trusted_session`：服务端可自动放行会话内的普通写操作，但仍受 Codex 的 MCP 工具审批配置约束。被判定为 `high` 的高危命令会在服务端直接拒绝；如确需执行，必须切换到 `ask_every_time`，由 Codex 宿主逐次审批后再进入 SSH 层。请勿将信任会话理解为绕过高危操作审批。

因此，`auto_readonly` 是服务端不可绕过的最小权限边界；Codex 的逐次工具审批则是所有授权等级都应保留的交互层保护。

## 凭据与隐私

密码和私钥口令保存在 Windows 凭据管理器中，`list_connection_profiles` 只返回不含这些秘密的连接配置信息。服务会尽力对命令、输出和错误中的已知常见秘密模式脱敏，包括 `password`、`token`、`api_key`、`access_token`、`refresh_token`、`client_secret`、`Bearer`、`Cookie` 和私钥块。

脱敏并非对任意秘密格式的数学保证：请不要将秘密直接写入命令或文件路径；如发现新的秘密格式，应扩展相应的脱敏规则。

## 数据迁移、主机指纹与文件传输边界

为保证改名前后的数据连续性，OrbitSSH 在 Windows 上继续从原兼容目录读取非敏感数据：

```text
%APPDATA%\AI SSH\ai-ssh.sqlite
```

SQLite 以 WAL 模式运行；运行期间同目录可能出现 `ai-ssh.sqlite-wal` 与 `ai-ssh.sqlite-shm`，它们属于数据库的一部分，不应单独删除。首次升级会在一个事务中把旧的 `profiles.json` 与 `history.json` 导入 SQLite，并将原文件保留为只读的 `.bak` 备份。迁移、备份或校验失败时，程序不会删除原 JSON，也不会以不完整的数据切换到 SQLite。

首次连接某个远程服务器时，SSH 会拒绝继续握手，并在桌面界面显示 SHA-256 主机指纹。只有用户通过可信渠道核对并在图形界面确认后，才会保存信任记录；后续指纹变化同样会被拒绝，并显示旧、新指纹以及中间人攻击风险。MCP 不提供接受、替换或绕过主机指纹的工具。

文件传输必须先在连接配置中设置“本地文件允许目录”和“远程文件允许目录”。远程目录每行一个，使用绝对 POSIX 路径，例如 `/srv/app`。未配置任一侧目录时，上传和下载都会在创建 SFTP 通道前被拒绝。

- 本地上传会解析真实路径，拒绝 `..`、符号链接和 Windows 大小写差异造成的目录逃逸。
- 本地下载只允许写入允许目录内且真实存在的父目录；既有链接目标也会重新验证。
- 远程路径必须属于已配置根目录，不能包含 `..`；相似前缀（如允许 `/srv/app` 却写入 `/srv/application`）不会被放行。

旧连接配置没有文件目录设置时保持可用，但文件传输将保持拒绝状态，直到用户在桌面应用中完成目录授权。

## 构建与冒烟验证

每次修改 MCP 或打包相关内容后，可在开发目录依次运行：

```powershell
cd D:\Code\ai-ssh
npm.cmd run build
npm.cmd run mcp:smoke
npm.cmd run build:windows
```

`mcp:smoke` 会验证开发产物；`build:windows` 会生成安装包，并继续验证打包后的桌面端、Runtime、SQLite 和 MCP。测试使用临时数据目录，不会读取或修改你的实际连接配置。

## 常见故障

- `codex mcp add` 找不到入口：确认 `$orbitssh` 指向实际安装目录，且其中存在 `OrbitSSH.exe` 与 `resources\mcp\server.js`。
- Codex 无法启动服务：使用 `codex mcp get orbitssh` 检查命令、两个绝对路径和 `ELECTRON_RUN_AS_NODE=1`，然后重新注册。
- 冒烟验证失败：先执行 `npm.cmd run build`，再执行 `npm.cmd run mcp:smoke`；查看命令输出中的 Node.js 或依赖错误。
- `auto_readonly` 下命令被拒绝：改用明确的单条只读检查命令，避免 `&&`、`|`、重定向和其他复合 Shell 语法；需要写入时改用经过人工审批的授权流程。
- 看不到连接配置：先在 OrbitSSH 桌面应用中创建配置，并确认当前 Windows 用户可访问相应的 Windows 凭据管理器条目。
