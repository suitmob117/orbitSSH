import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CredentialVault } from '../src/core/credential-vault';
import { HistoryStore } from '../src/core/history-store';
import { ProfileStore } from '../src/core/profile-store';
import { createCoreServices } from '../src/core/services';
import { SqliteStore, type SqliteStorePort } from '../src/core/sqlite-store';
import type { CommandRecord, ConnectionProfile } from '../src/shared/types';

const profileInput = {
  name: '生产环境',
  host: '203.0.113.10',
  port: 22,
  username: 'root',
  authMethod: 'ssh_agent' as const,
  connectTimeoutMs: 10_000,
  keepaliveIntervalMs: 15_000,
  localTransferRoot: 'C:\\Users\\tester\\Downloads',
  remoteTransferRoots: ['/srv/app', '/var/log/app']
};

const historyInput = {
  sessionId: 'session-1',
  command: 'uptime',
  startedAt: '2026-07-22T00:00:00.000Z',
  finishedAt: '2026-07-22T00:00:01.000Z',
  exitCode: 0,
  stdoutTail: 'up 1 day',
  stderrTail: '',
  summary: '正常'
};

type JsonPort<T> = {
  read(): Promise<T>;
  write(value: T): Promise<void>;
};

async function removeTemporaryDirectory(dataDir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '') || attempt === 5) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

function credentialVault(): CredentialVault {
  return {
    getSecret: async () => undefined,
    setSecret: async () => undefined,
    deleteSecret: async () => undefined
  } as unknown as CredentialVault;
}

function unavailableSqlite(): SqliteStorePort {
  return {
    status: { usingJsonFallback: false, unavailable: true, migrationBlocked: false, reason: 'locked' },
    listProfiles: () => {
      throw new Error('locked');
    },
    saveProfile: () => {
      throw new Error('locked');
    },
    deleteProfile: () => {
      throw new Error('locked');
    },
    listHistory: () => {
      throw new Error('locked');
    },
    appendHistory: () => {
      throw new Error('locked');
    },
    getHostKey: () => {
      throw new Error('locked');
    },
    saveHostKey: () => {
      throw new Error('locked');
    },
    close: () => undefined
  };
}

test('正常 SQLite 路径中配置和历史不再改写旧 JSON', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-ssh-store-integration-'));
  const sqlite = new SqliteStore(dataDir);
  try {
    const profileJson: JsonPort<ConnectionProfile[]> = {
      read: async () => {
        throw new Error('不应读取 JSON');
      },
      write: async () => {
        throw new Error('不应写入 JSON');
      }
    };
    const historyJson: JsonPort<CommandRecord[]> = {
      read: async () => {
        throw new Error('不应读取 JSON');
      },
      write: async () => {
        throw new Error('不应写入 JSON');
      }
    };
    const profiles = new ProfileStore(credentialVault(), { sqlite, jsonStore: profileJson });
    const history = new HistoryStore({ sqlite, jsonStore: historyJson });

    const saved = await profiles.save(profileInput);
    const record = await history.append(historyInput);

    assert.deepEqual(JSON.parse(JSON.stringify(await profiles.list())), JSON.parse(JSON.stringify([saved])));
    assert.deepEqual(await history.list(), [record]);
  } finally {
    sqlite.close();
    await removeTemporaryDirectory(dataDir);
  }
});

test('SQLite 暂不可用时绝不回退或改写 JSON', async () => {
  let profileWrites = 0;
  let historyWrites = 0;
  const profiles = new ProfileStore(credentialVault(), {
    sqlite: unavailableSqlite(),
    jsonStore: {
      read: async () => [],
      write: async () => {
        profileWrites += 1;
      }
    }
  });
  const history = new HistoryStore({
    sqlite: unavailableSqlite(),
    jsonStore: {
      read: async () => [],
      write: async () => {
        historyWrites += 1;
      }
    }
  });

  await assert.rejects(profiles.save(profileInput), /locked/);
  await assert.rejects(history.append(historyInput), /locked/);
  assert.equal(profileWrites, 0);
  assert.equal(historyWrites, 0);
});

test('仅安全 JSON 回退状态允许继续读写旧 JSON', async () => {
  const storedProfiles: ConnectionProfile[] = [];
  const storedHistory: CommandRecord[] = [];
  const fallbackSqlite = {
    ...unavailableSqlite(),
    status: { usingJsonFallback: true, unavailable: false, migrationBlocked: false }
  };
  const profiles = new ProfileStore(credentialVault(), {
    sqlite: fallbackSqlite,
    jsonStore: {
      read: async () => storedProfiles,
      write: async (value) => {
        storedProfiles.splice(0, storedProfiles.length, ...value);
      }
    }
  });
  const history = new HistoryStore({
    sqlite: fallbackSqlite,
    jsonStore: {
      read: async () => storedHistory,
      write: async (value) => {
        storedHistory.splice(0, storedHistory.length, ...value);
      }
    }
  });

  const saved = await profiles.save(profileInput);
  const record = await history.append(historyInput);
  assert.deepEqual(storedProfiles, [saved]);
  assert.deepEqual(storedHistory, [record]);
});

test('核心服务将同一个可替换 SQLite 实例注入配置与历史存储', async () => {
  let closeCalls = 0;
  const sqlite = {
    ...unavailableSqlite(),
    status: { usingJsonFallback: false, unavailable: false, migrationBlocked: false },
    listProfiles: () => [],
    listHistory: () => [],
    close: () => {
      closeCalls += 1;
    }
  };
  const services = createCoreServices({ credentialVault: credentialVault(), sqliteStore: sqlite });

  assert.equal(services.sqliteStore, sqlite);
  assert.deepEqual(await services.profileStore.list(), []);
  assert.deepEqual(await services.historyStore.list(), []);
  services.close();
  services.close();
  assert.equal(closeCalls, 1);
});

test('保存配置失败时恢复已有凭据，不留下新凭据', async () => {
  const profileId = 'profile-with-password';
  const passwordId = `${profileId}:password`;
  const secrets = new Map([[passwordId, '旧密码']]);
  const vault = {
    getSecret: async (id?: string) => id ? secrets.get(id) : undefined,
    setSecret: async (id: string, value: string) => {
      secrets.set(id, value);
    },
    deleteSecret: async (id?: string) => {
      if (id) secrets.delete(id);
    }
  } as CredentialVault;
  const existing: ConnectionProfile = {
    id: profileId,
    ...profileInput,
    authMethod: 'saved_password',
    credentialId: passwordId,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  };
  const sqlite = {
    ...unavailableSqlite(),
    status: { usingJsonFallback: false, unavailable: false, migrationBlocked: false },
    listProfiles: () => [existing],
    saveProfile: () => {
      throw new Error('database write failed');
    }
  };
  const profiles = new ProfileStore(vault, { sqlite });

  await assert.rejects(profiles.save({ ...profileInput, authMethod: 'saved_password', password: '新密码' }, profileId), /database write failed/);
  assert.equal(secrets.get(passwordId), '旧密码');

  const newProfileStore = new ProfileStore(vault, {
    sqlite: { ...sqlite, listProfiles: () => [] }
  });
  await assert.rejects(newProfileStore.save({ ...profileInput, authMethod: 'saved_password', password: '不会残留' }, 'new-profile'), /database write failed/);
  assert.equal(secrets.has('new-profile:password'), false);
});

test('删除配置时先持久化，SQLite 失败不会删除凭据', async () => {
  const profileId = 'profile-delete-failure';
  const passwordId = `${profileId}:password`;
  const secrets = new Map([[passwordId, '必须保留']]);
  const vault = {
    getSecret: async (id?: string) => id ? secrets.get(id) : undefined,
    setSecret: async (id: string, value: string) => {
      secrets.set(id, value);
    },
    deleteSecret: async (id?: string) => {
      if (id) secrets.delete(id);
    }
  } as CredentialVault;
  const existing: ConnectionProfile = {
    id: profileId,
    ...profileInput,
    authMethod: 'saved_password',
    credentialId: passwordId,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  };
  const sqlite = {
    ...unavailableSqlite(),
    status: { usingJsonFallback: false, unavailable: false, migrationBlocked: false },
    listProfiles: () => [existing],
    deleteProfile: () => {
      throw new Error('database delete failed');
    }
  };
  const profiles = new ProfileStore(vault, { sqlite });

  await assert.rejects(profiles.delete(profileId), /database delete failed/);
  assert.equal(secrets.get(passwordId), '必须保留');
});

test('取消记住私钥口令时持久化 undefined 引用并删除旧凭据', async () => {
  const profileId = 'private-key-profile';
  const passphraseId = `${profileId}:private-key-passphrase`;
  const secrets = new Map([[passphraseId, '旧口令']]);
  const existing: ConnectionProfile = {
    id: profileId,
    ...profileInput,
    authMethod: 'private_key',
    privateKeyPath: 'C:\\keys\\id_ed25519',
    privateKeyPassphraseCredentialId: passphraseId,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  };
  let persisted: ConnectionProfile | undefined;
  const profiles = new ProfileStore({
    getSecret: async (id?: string) => id ? secrets.get(id) : undefined,
    setSecret: async (id: string, value: string) => { secrets.set(id, value); },
    deleteSecret: async (id?: string) => { if (id) secrets.delete(id); }
  } as CredentialVault, {
    sqlite: {
      ...unavailableSqlite(),
      status: { usingJsonFallback: false, unavailable: false, migrationBlocked: false },
      listProfiles: () => [existing],
      saveProfile: (profile) => {
        persisted = profile;
        return profile;
      }
    }
  });

  await profiles.save({
    ...profileInput,
    authMethod: 'private_key',
    privateKeyPath: 'C:\\keys\\id_ed25519',
    rememberPrivateKeyPassphrase: false
  }, profileId);
  assert.equal(persisted?.privateKeyPassphraseCredentialId, undefined);
  assert.equal(secrets.has(passphraseId), false);
});

test('保存失败后的新凭据清理异常会向调用方传播', async () => {
  const profiles = new ProfileStore({
    getSecret: async () => undefined,
    setSecret: async () => undefined,
    deleteSecret: async () => {
      throw new Error('credential cleanup failed');
    }
  } as unknown as CredentialVault, {
    sqlite: {
      ...unavailableSqlite(),
      status: { usingJsonFallback: false, unavailable: false, migrationBlocked: false },
      listProfiles: () => [],
      saveProfile: () => {
        throw new Error('database write failed');
      }
    }
  });

  await assert.rejects(
    profiles.save({ ...profileInput, authMethod: 'saved_password', password: 'new secret' }, 'cleanup-failure'),
    /credential cleanup failed/
  );
});

test('SQLite 历史记录最多保留最新 500 条', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-ssh-history-limit-'));
  const sqlite = new SqliteStore(dataDir);
  try {
    const history = new HistoryStore({ sqlite, jsonStore: { read: async () => [], write: async () => undefined } });
    for (let index = 0; index < 501; index += 1) {
      await history.append({ ...historyInput, command: `echo ${index}` });
    }
    const records = await history.list();
    assert.equal(records.length, 500);
    assert.equal(records[0]?.command, 'echo 1');
    assert.equal(records.at(-1)?.command, 'echo 500');
  } finally {
    sqlite.close();
    await removeTemporaryDirectory(dataDir);
  }
});
