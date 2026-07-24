import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { connectRuntime } from '../src/runtime/runtime-client';
import type { ConnectionProfile } from '../src/shared/types';

function testEndpoint(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\orbitssh-host-test-${process.pid}-${randomUUID()}`
    : path.join(os.tmpdir(), `orbitssh-host-test-${process.pid}-${randomUUID()}.sock`);
}

test('独立 Runtime Host 让 Electron 与 MCP 读取同一份配置和运行状态', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'orbitssh-runtime-host-'));
  const endpoint = testEndpoint();
  const previousDataDir = process.env.AI_SSH_DATA_DIR;
  const previousEntry = process.env.ORBITSSH_RUNTIME_ENTRY;
  process.env.AI_SSH_DATA_DIR = dataDir;
  process.env.ORBITSSH_RUNTIME_ENTRY = path.resolve('src/runtime/host-entry.ts');

  let desktop;
  let mcp;
  try {
    desktop = await connectRuntime({ kind: 'desktop', endpoint });
    const saved = await desktop.call<ConnectionProfile>('profiles:save', {
      input: {
        name: '共享测试服务器',
        host: '127.0.0.1',
        port: 22,
        username: 'tester',
        authMethod: 'ssh_agent',
        connectTimeoutMs: 10_000,
        keepaliveIntervalMs: 15_000
      }
    });

    mcp = await connectRuntime({ kind: 'mcp', endpoint, startIfMissing: false });
    const profiles = await mcp.call<ConnectionProfile[]>('profiles:list', {});
    const snapshot = await mcp.call<{ desktopAttached: boolean; mcpClientCount: number }>('runtime:snapshot', {});

    assert.equal(profiles[0]?.id, saved.id);
    assert.equal(snapshot.desktopAttached, true);
    assert.equal(snapshot.mcpClientCount, 1);
    await mcp.close();
    mcp = undefined;
    await desktop.call('runtime:set-exit-policy', { policy: 'close_all' });
  } finally {
    await mcp?.close().catch(() => undefined);
    await desktop?.close().catch(() => undefined);
    if (previousDataDir === undefined) delete process.env.AI_SSH_DATA_DIR;
    else process.env.AI_SSH_DATA_DIR = previousDataDir;
    if (previousEntry === undefined) delete process.env.ORBITSSH_RUNTIME_ENTRY;
    else process.env.ORBITSSH_RUNTIME_ENTRY = previousEntry;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
