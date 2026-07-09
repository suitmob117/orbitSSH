import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createCoreServices } from '../core/services';

const services = createCoreServices();

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
  name: 'ai-ssh',
  version: '0.1.0'
});

server.registerTool(
  'list_connection_profiles',
  {
    title: 'List connection profiles',
    description: 'List saved AI SSH connection profiles without secrets.'
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
    description: 'Check whether an AI SSH connection session is connected, degraded, or disconnected.',
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
    title: 'Upload file',
    description: 'Upload a local file to a remote path through an existing SSH session.',
    inputSchema: {
      sessionId: z.string(),
      localPath: z.string(),
      remotePath: z.string()
    }
  },
  async ({ sessionId, localPath, remotePath }) =>
    text(await services.sessionManager.transferFile({ sessionId, localPath, remotePath, direction: 'upload' }))
);

server.registerTool(
  'download_file',
  {
    title: 'Download file',
    description: 'Download a remote file to a local path through an existing SSH session.',
    inputSchema: {
      sessionId: z.string(),
      remotePath: z.string(),
      localPath: z.string()
    }
  },
  async ({ sessionId, remotePath, localPath }) =>
    text(await services.sessionManager.transferFile({ sessionId, localPath, remotePath, direction: 'download' }))
);

server.registerTool(
  'close_connection_session',
  {
    title: 'Close connection session',
    description: 'Close a persistent AI SSH connection session explicitly.',
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
