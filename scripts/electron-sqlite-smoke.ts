import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteStore } from '../src/core/sqlite-store';

let temporaryDirectory: string | undefined;

try {
  assert.ok(process.versions.electron, '必须在 Electron 运行时中执行 SQLite 冒烟测试');
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ai-ssh-electron-sqlite-'));
  const store = new SqliteStore(temporaryDirectory);
  assert.equal(store.status.usingJsonFallback, false, store.status.reason);
  assert.equal(store.journalMode(), 'wal');
  assert.equal(store.hasSchema('profiles'), true);
  assert.equal(store.hasSchema('command_history'), true);

  store.saveProfile({
    id: 'electron-profile',
    name: 'Electron 冒烟',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'ssh_agent',
    connectTimeoutMs: 10_000,
    keepaliveIntervalMs: 15_000,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  });
  store.appendHistory({
    id: 'electron-history',
    sessionId: 'electron-session',
    command: 'uptime',
    startedAt: '2026-07-22T00:00:00.000Z',
    exitCode: 0,
    stdoutTail: 'ok',
    stderrTail: '',
    summary: 'Electron SQLite 正常'
  });
  assert.equal(store.listProfiles()[0]?.id, 'electron-profile');
  assert.equal(store.listHistory()[0]?.id, 'electron-history');
  store.close();
  console.log('Electron SqliteStore smoke test passed.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
  process.exit(process.exitCode ?? 0);
}
