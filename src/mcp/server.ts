import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerProcessCleanup } from '../core/process-lifecycle';
import { connectRuntime } from '../runtime/runtime-client';

const runtime = await connectRuntime({ kind: 'mcp' });
registerProcessCleanup(() => { void runtime.close(); });

let runtimeConnected = true;
runtime.on('close', () => { runtimeConnected = false; });

function assertConnected() {
  if (!runtimeConnected) {
    throw new Error('OrbitSSH Runtime 连接已断开，请重启 MCP 客户端以重新连接');
  }
}

function text(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

const server = new McpServer({
  name: 'orbitssh',
  version: '0.1.0'
});

server.registerTool(
  'list_connection_profiles',
  {
    title: 'List connection profiles',
    description: 'List saved OrbitSSH connection profiles without secrets.'
  },
  async () => { assertConnected(); return text(await runtime.call('profiles:list', {})); }
);

server.registerTool(
  'open_connection_session',
  {
    title: 'Open connection session',
    description: 'Open or reuse a persistent SSH connection session. Use forceNew to close any existing session first.',
    inputSchema: {
      profileId: z.string(),
      forceNew: z.boolean().optional().describe('Force close existing session and create a new one')
    }
  },
  async ({ profileId, forceNew }) => { assertConnected(); return text(await runtime.call('sessions:open', { profileId, forceNew })); }
);

server.registerTool(
  'get_session_health',
  {
    title: 'Get session health',
    description: 'Check whether an OrbitSSH connection session is connected, degraded, or disconnected.',
    inputSchema: {
      sessionId: z.string()
    }
  },
  async ({ sessionId }) => { assertConnected(); return text(await runtime.call('sessions:health', { sessionId })); }
);

server.registerTool(
  'run_remote_command',
  {
    title: 'Run remote command',
    description: 'Run a command through an independent SSH exec channel. Does not occupy the interactive terminal.',
    inputSchema: {
      sessionId: z.string(),
      command: z.string()
    }
  },
  async ({ sessionId, command }) => { assertConnected(); return text(await runtime.call('commands:request', { sessionId, command })); }
);

server.registerTool(
  'cancel_command',
  {
    title: 'Cancel running command',
    description: 'Cancel any running remote command on the session. Sends Ctrl+C to terminal or closes exec channel.',
    inputSchema: {
      sessionId: z.string()
    }
  },
  async ({ sessionId }) => { assertConnected(); return text(await runtime.call('commands:cancel', { sessionId })); }
);

server.registerTool(
  'close_session',
  {
    title: 'Close session',
    description: 'Forcefully close an SSH session and release all resources including terminals and exec channels.',
    inputSchema: {
      sessionId: z.string()
    }
  },
  async ({ sessionId }) => { assertConnected(); return text(await runtime.call('sessions:close', { sessionId })); }
);

server.registerTool(
  'upload_file',
  {
    title: '上传文件',
    description: '通过现有 SSH 会话上传文件。路径必须位于该连接配置的本地与远程允许目录内。',
    inputSchema: {
      sessionId: z.string().describe('现有 SSH 会话 ID'),
      localPath: z.string().describe('本地文件路径，必须位于连接配置的本地允许目录内'),
      remotePath: z.string().describe('远程 POSIX 路径，必须位于连接配置的远程允许目录内')
    }
  },
  async ({ sessionId, localPath, remotePath }) => {
    assertConnected();
    return text(await runtime.call('files:request', { sessionId, localPath, remotePath, direction: 'upload' }));
  }
);

server.registerTool(
  'download_file',
  {
    title: '下载文件',
    description: '通过现有 SSH 会话下载文件。路径必须位于该连接配置的本地与远程允许目录内。',
    inputSchema: {
      sessionId: z.string().describe('现有 SSH 会话 ID'),
      remotePath: z.string().describe('远程 POSIX 路径，必须位于连接配置的远程允许目录内'),
      localPath: z.string().describe('本地目标路径，父目录必须真实存在且位于连接配置的本地允许目录内')
    }
  },
  async ({ sessionId, remotePath, localPath }) => {
    assertConnected();
    return text(await runtime.call('files:request', { sessionId, localPath, remotePath, direction: 'download' }));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
