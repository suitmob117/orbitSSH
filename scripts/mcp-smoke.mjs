import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dataDir = await mkdtemp(path.join(tmpdir(), 'ai-ssh-mcp-smoke-'));
const client = new Client({ name: 'ai-ssh-smoke', version: '1.0.0' });

try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/mcp/server.js')],
    cwd: process.cwd(),
    env: { ...process.env, AI_SSH_DATA_DIR: dataDir },
    stderr: 'inherit'
  });

  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(
    tools.tools.some((tool) => /host.*key|fingerprint|trust|accept|replace/i.test(tool.name)),
    false,
    'MCP 不得暴露 SSH 主机指纹接受或替换入口'
  );
  const result = await client.callTool({
    name: 'list_connection_profiles',
    arguments: {}
  });
  const profiles = JSON.parse(result.content[0]?.text ?? 'null');

  if (!Array.isArray(profiles)) {
    throw new Error('MCP 冒烟测试失败：连接配置列表不是数组');
  }

  console.log(`MCP 冒烟测试通过：${profiles.length} 个连接配置`);
  // MCP 入口必须走真实 SQLite，而不是只验证 JSON 空列表的旧路径。
  const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'), { readonly: true });
  assert.equal(String(database.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profiles'").get());
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'command_history'").get());
  database.close();
} finally {
  await client.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}
