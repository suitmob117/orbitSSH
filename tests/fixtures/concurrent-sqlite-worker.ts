import { existsSync } from 'node:fs';

import { CredentialVault } from '../../src/core/credential-vault';
import { HistoryStore } from '../../src/core/history-store';
import { ProfileStore } from '../../src/core/profile-store';
import { SqliteStore } from '../../src/core/sqlite-store';

const [dataDir, workerId, startFile] = process.argv.slice(2);
if (!dataDir || !workerId || !startFile) throw new Error('缺少并发测试参数');

process.stdout.write('READY\n');
while (!existsSync(startFile)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

const sqlite = new SqliteStore(dataDir);
try {
  const vault = {
    getSecret: async () => undefined,
    setSecret: async () => undefined,
    deleteSecret: async () => undefined
  } as unknown as CredentialVault;
  const profiles = new ProfileStore(vault, { sqlite });
  const history = new HistoryStore({ sqlite });

  await profiles.save({
    name: workerId,
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'ssh_agent',
    connectTimeoutMs: 10_000,
    keepaliveIntervalMs: 15_000
  }, workerId);
  await history.append({
    sessionId: workerId,
    command: 'uptime',
    startedAt: '2026-07-22T00:00:00.000Z',
    exitCode: 0,
    stdoutTail: workerId,
    stderrTail: '',
    summary: '并发写入'
  });
} finally {
  sqlite.close();
}
