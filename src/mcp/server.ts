import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createCoreServices } from '../core/services';
import { registerProcessCleanup } from '../core/process-lifecycle';

const services = createCoreServices();
registerProcessCleanup(services.close);

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
  async () => text(await services.profileStore.list())
);

server.registerTool(
  'open_connection_session',
  {
    title: 'Open connection session',
    description: 'Open or reuse a persistent SSH connection session.',
    inputSchema: {
      profileId: z.string(),
      authorizationLevel: z.enum(['ask_every_time', 'auto_readonly', 'trusted_session']).default('ask_every_time')
    }
  },
  async ({ profileId, authorizationLevel }) => text(await services.sessionManager.openSession(profileId, authorizationLevel))
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
  async ({ sessionId }) => text(await services.sessionManager.getHealth(sessionId))
);

server.registerTool(
  'run_remote_command',
  {
    title: 'Run remote command',
    description: 'Run a command through an existing persistent SSH session.',
    inputSchema: {
      sessionId: z.string(),
      command: z.string()
    }
  },
  async ({ sessionId, command }) => text(await services.sessionManager.runCommand(sessionId, command))
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
  async ({ sessionId, localPath, remotePath }) =>
    text(await services.sessionManager.transferFile({ sessionId, localPath, remotePath, direction: 'upload' }))
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
  async ({ sessionId, remotePath, localPath }) =>
    text(await services.sessionManager.transferFile({ sessionId, localPath, remotePath, direction: 'download' }))
);

server.registerTool(
  'close_connection_session',
  {
    title: 'Close connection session',
    description: 'Close a persistent OrbitSSH connection session explicitly.',
    inputSchema: {
      sessionId: z.string()
    }
  },
  async ({ sessionId }) => {
    await services.sessionManager.closeSession(sessionId);
    return text({ ok: true });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
