import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveSqliteDriverModuleName, SqliteStore } from '../src/core/sqlite-store';

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ai-ssh-node-sqlite-'));
try {
  assert.equal(process.versions.electron, undefined, 'Node SQLite 冒烟测试不能运行在 Electron ABI 中');
  assert.equal(resolveSqliteDriverModuleName(), 'better-sqlite3');
  const store = new SqliteStore(temporaryDirectory);
  assert.equal(store.status.usingJsonFallback, false, store.status.reason);
  assert.equal(store.journalMode(), 'wal');
  store.saveProfile({
    id: 'node-profile',
    name: 'Node 冒烟',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'ssh_agent',
    connectTimeoutMs: 10_000,
    keepaliveIntervalMs: 15_000,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  });
  assert.equal(store.listProfiles()[0]?.id, 'node-profile');
  store.close();
  console.log('Node SqliteStore smoke test passed.');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
