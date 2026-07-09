# Codex MCP Setup

AI SSH is intended to be used by Codex as a local MCP server. Codex keeps its own AI configuration; AI SSH only exposes SSH tools.

## Planned Codex Config

After AI SSH is built, add a server entry like this to `C:\Users\Lighthouse\.codex\config.toml`:

```toml
[mcp_servers.ai_ssh]
enabled = true
command = "node"
args = ["D:\\Code\\ai-ssh\\dist\\mcp\\server.js"]
cwd = "D:\\Code\\ai-ssh"
startup_timeout_sec = 10
tool_timeout_sec = 300
default_tools_approval_mode = "prompt"

enabled_tools = [
  "list_connection_profiles",
  "open_connection_session",
  "get_session_health",
  "run_remote_command",
  "upload_file",
  "download_file",
  "close_connection_session",
]

[mcp_servers.ai_ssh.tools.list_connection_profiles]
approval_mode = "auto"

[mcp_servers.ai_ssh.tools.get_session_health]
approval_mode = "auto"

[mcp_servers.ai_ssh.tools.open_connection_session]
approval_mode = "prompt"

[mcp_servers.ai_ssh.tools.run_remote_command]
approval_mode = "prompt"

[mcp_servers.ai_ssh.tools.upload_file]
approval_mode = "prompt"

[mcp_servers.ai_ssh.tools.download_file]
approval_mode = "prompt"

[mcp_servers.ai_ssh.tools.close_connection_session]
approval_mode = "prompt"
```

## Expected Runtime Flow

1. Start the AI SSH desktop app.
2. AI SSH starts or supervises its local MCP server.
3. Codex launches the configured MCP server command when a thread starts.
4. Codex calls AI SSH tools instead of opening ad hoc SSH sessions itself.
5. AI SSH enforces the selected authorization level and reuses persistent SSH sessions.

## Tool Contract

- `list_connection_profiles`: returns saved connection profiles without secrets.
- `open_connection_session`: creates or reuses a persistent connection session.
- `get_session_health`: returns connected, degraded, or disconnected state.
- `run_remote_command`: runs a command through the selected session authorization policy.
- `upload_file`: uploads a local file to a remote path.
- `download_file`: downloads a remote file to a local path.
- `close_connection_session`: explicitly closes a persistent connection session.
