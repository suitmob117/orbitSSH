# Codex MCP 本地接入指南

本指南将开发目录中的 AI SSH MCP 服务接入 Codex。它适用于本机开发和验证；正式的 Plugin、Marketplace 或一键安装流程属于后续阶段。

## 接入前准备

请先在 AI SSH 开发目录构建生产产物：

```powershell
cd D:\Code\ai-ssh
npm.cmd run build
```

生产入口的绝对路径为：

```text
D:\Code\ai-ssh\dist\mcp\server.js
```

不要将 `src/mcp/server.ts`、临时目录或旧的手工配置路径作为 Codex 的生产入口。

## 注册与检查

构建成功后，执行以下命令注册本地 MCP 服务：

```powershell
codex mcp add ai_ssh -- node D:\Code\ai-ssh\dist\mcp\server.js
```

随后检查注册结果和当前可用的 MCP 服务：

```powershell
codex mcp get ai_ssh
codex mcp list
```

如果需要重新注册，先按 Codex CLI 的当前帮助移除或替换已有的 `ai_ssh` 条目，再重复上面的注册和检查步骤。

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
- `trusted_session`：服务端允许会话内请求继续到 SSH 层，但仍受 Codex 的 MCP 工具审批配置约束；请勿将它理解为绕过 Codex 审批。

因此，`auto_readonly` 是服务端不可绕过的最小权限边界；Codex 的逐次工具审批则是所有授权等级都应保留的交互层保护。

## 凭据与隐私

密码和私钥口令保存在 Windows 凭据管理器中，`list_connection_profiles` 只返回不含这些秘密的连接配置信息。服务会尽力对命令、输出和错误中的已知常见秘密模式脱敏，包括 `password`、`token`、`api_key`、`access_token`、`refresh_token`、`client_secret`、`Bearer`、`Cookie` 和私钥块。

脱敏并非对任意秘密格式的数学保证：请不要将秘密直接写入命令或文件路径；如发现新的秘密格式，应扩展相应的脱敏规则。

## 构建与冒烟验证

每次修改 MCP 相关内容后，可在开发目录依次运行：

```powershell
cd D:\Code\ai-ssh
npm.cmd run build
npm.cmd run mcp:smoke
```

`mcp:smoke` 会启动已构建的生产 stdio 服务 `dist/mcp/server.js`，并调用 `list_connection_profiles` 验证 MCP 协议链路。测试使用临时数据目录，不会读取或修改你的实际连接配置。

## 常见故障

- `codex mcp add` 找不到入口：先重新执行 `npm.cmd run build`，并确认 `D:\Code\ai-ssh\dist\mcp\server.js` 存在。
- Codex 无法启动服务：使用 `codex mcp get ai_ssh` 检查命令是否为 `node D:\Code\ai-ssh\dist\mcp\server.js`，然后重新注册。
- 冒烟验证失败：先执行 `npm.cmd run build`，再执行 `npm.cmd run mcp:smoke`；查看命令输出中的 Node.js 或依赖错误。
- `auto_readonly` 下命令被拒绝：改用明确的单条只读检查命令，避免 `&&`、`|`、重定向和其他复合 Shell 语法；需要写入时改用经过人工审批的授权流程。
- 看不到连接配置：先在 AI SSH 桌面应用中创建配置，并确认当前 Windows 用户可访问相应的 Windows 凭据管理器条目。
