import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HostKeyStore } from '../src/core/host-key-store';
import { SqliteStore } from '../src/core/sqlite-store';
import type { ConnectionProfile } from '../src/shared/types';

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-ssh-host-keys-'));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function profile(host = 'server.example.com', port = 22): ConnectionProfile {
  return {
    id: 'profile-1',
    name: '生产服务器',
    host,
    port,
    username: 'root',
    authMethod: 'ssh_agent',
    connectTimeoutMs: 15_000,
    keepaliveIntervalMs: 15_000,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  };
}

test('仅在桌面端明确确认后写入首次主机指纹，并可安全替换已变化指纹', async () => {
  await withDataDir(async (dataDir) => {
    const sqlite = new SqliteStore(dataDir);
    const store = new HostKeyStore(sqlite);
    const first = {
      challengeId: '00000000-0000-4000-8000-000000000001',
      profileId: 'profile-1',
      host: 'server.example.com',
      port: 22,
      oldFingerprint: undefined,
      newFingerprint: 'SHA256:first',
      risk: 'first_seen' as const
    };

    assert.equal(store.get('profile-1'), undefined);
    store.confirm(first);
    assert.equal(store.get('profile-1')?.fingerprint, 'SHA256:first');

    store.confirm({ ...first, oldFingerprint: 'SHA256:first', newFingerprint: 'SHA256:changed', risk: 'changed' });
    assert.equal(store.get('profile-1')?.fingerprint, 'SHA256:changed');
    sqlite.close();
  });
});

test('编辑同一配置的主机端点或删除配置时，同一事务清除旧主机信任', async () => {
  await withDataDir(async (dataDir) => {
    const sqlite = new SqliteStore(dataDir);
    const store = new HostKeyStore(sqlite);
    const first = {
      challengeId: '00000000-0000-4000-8000-000000000002',
      profileId: 'profile-1',
      host: 'server.example.com',
      port: 22,
      newFingerprint: 'SHA256:first',
      risk: 'first_seen' as const
    };

    sqlite.saveProfile(profile());
    store.confirm(first);
    sqlite.saveProfile(profile('new-server.example.com', 2222));
    assert.equal(store.get('profile-1'), undefined);

    store.confirm({ ...first, host: 'new-server.example.com', port: 2222, newFingerprint: 'SHA256:second' });
    sqlite.deleteProfile('profile-1');
    assert.equal(store.get('profile-1'), undefined);
    sqlite.saveProfile(profile('new-server.example.com', 2222));
    assert.equal(store.get('profile-1'), undefined);
    sqlite.close();
  });
});
