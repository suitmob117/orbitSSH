import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';

import { CredentialVault } from '../src/core/credential-vault';
import { ProfileStore } from '../src/core/profile-store';
import {
  resolveSqliteDriverModuleName,
  SqliteStore,
  SqliteStoreUnavailableError
} from '../src/core/sqlite-store';

const legacyProfile = {
  id: 'profile-1',
  name: '生产环境',
  host: '203.0.113.10',
  port: 22,
  username: 'root',
  authMethod: 'saved_password',
  credentialId: 'ai-ssh:profile-1:password',
  connectTimeoutMs: 10_000,
  keepaliveIntervalMs: 15_000,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z'
};

const legacyRecord = {
  id: 'record-1',
  sessionId: 'session-1',
  command: 'uptime',
  startedAt: '2026-07-21T00:01:00.000Z',
  finishedAt: '2026-07-21T00:01:01.000Z',
  exitCode: 0,
  stdoutTail: 'up 3 days',
  stderrTail: '',
  summary: '服务正常'
};

const trackedStores = new Map<string, Set<SqliteStore>>();

function openStore(dataDir: string, options?: ConstructorParameters<typeof SqliteStore>[1]): SqliteStore {
  const store = new SqliteStore(dataDir, options);
  const stores = trackedStores.get(dataDir) ?? new Set<SqliteStore>();
  stores.add(store);
  trackedStores.set(dataDir, stores);
  return store;
}

async function removeDataDir(dataDir: string): Promise<void> {
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

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-ssh-sqlite-'));
  try {
    await run(dataDir);
  } finally {
    for (const store of trackedStores.get(dataDir) ?? []) store.close();
    trackedStores.delete(dataDir);
    await removeDataDir(dataDir);
  }
}

test('Node/MCP 与 Electron 为 SQLite 选择彼此独立的原生模块目录', () => {
  assert.equal(resolveSqliteDriverModuleName({}), 'better-sqlite3');
  assert.equal(resolveSqliteDriverModuleName({ electron: '33.2.1' }), 'better-sqlite3-electron');
});

test('在同一事务中迁移旧 JSON，启用 WAL 并保留只读备份', async () => {
  await withDataDir(async (dataDir) => {
    await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify([legacyProfile]), 'utf8');
    await writeFile(path.join(dataDir, 'history.json'), JSON.stringify([legacyRecord]), 'utf8');

    const store = openStore(dataDir);
    assert.deepEqual(store.listProfiles(), [legacyProfile]);
    assert.deepEqual(store.listHistory(), [legacyRecord]);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(store.journalMode(), 'wal');
    assert.equal(store.hasSchema('profiles'), true);
    assert.equal(store.hasSchema('command_history'), true);
    assert.equal(store.hasSchema('host_keys'), true);
    assert.equal(await stat(path.join(dataDir, 'profiles.json.bak')).then(() => true), true);
    assert.equal(await stat(path.join(dataDir, 'history.json.bak')).then(() => true), true);
    assert.equal((await stat(path.join(dataDir, 'profiles.json.bak'))).mode & 0o222, 0);
    assert.equal((await stat(path.join(dataDir, 'history.json.bak'))).mode & 0o222, 0);
    assert.equal(await readFile(path.join(dataDir, 'profiles.json'), 'utf8'), JSON.stringify([legacyProfile]));
    assert.equal(await readFile(path.join(dataDir, 'history.json'), 'utf8'), JSON.stringify([legacyRecord]));
    store.close();
  });
});

test('完成标记写入失败时已先建立只读备份，并保留可供 JSON 回退读取的原始数据', async () => {
  await withDataDir(async (dataDir) => {
    await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify([legacyProfile]), 'utf8');
    await writeFile(path.join(dataDir, 'history.json'), JSON.stringify([legacyRecord]), 'utf8');

    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'));
    database.exec(`
      CREATE TABLE migration_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TRIGGER fail_migration_state
      BEFORE INSERT ON migration_state
      WHEN NEW.key = 'legacy-json-migration-v1' AND NEW.value = 'complete'
      BEGIN SELECT RAISE(FAIL, 'migration state blocked'); END;
    `);
    database.close();

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, true);
    assert.match(store.status.reason ?? '', /migration state blocked/);
    assert.equal(await readFile(path.join(dataDir, 'profiles.json'), 'utf8'), JSON.stringify([legacyProfile]));
    assert.equal(await readFile(path.join(dataDir, 'history.json'), 'utf8'), JSON.stringify([legacyRecord]));
    assert.equal(await readFile(path.join(dataDir, 'profiles.json.bak'), 'utf8'), JSON.stringify([legacyProfile]));
    assert.equal(await readFile(path.join(dataDir, 'history.json.bak'), 'utf8'), JSON.stringify([legacyRecord]));
    store.close();
  });
});

test('事务失败后安全回退写入 JSON，重启可从当前 JSON 迁移且不覆盖旧备份', async () => {
  await withDataDir(async (dataDir) => {
    const profilesPath = path.join(dataDir, 'profiles.json');
    const historyPath = path.join(dataDir, 'history.json');
    const originalProfiles = JSON.stringify([legacyProfile]);
    await writeFile(profilesPath, originalProfiles, 'utf8');
    await writeFile(historyPath, JSON.stringify([legacyRecord]), 'utf8');

    const databasePath = path.join(dataDir, 'ai-ssh.sqlite');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE migration_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TRIGGER fail_migration_state
      BEFORE INSERT ON migration_state
      WHEN NEW.key = 'legacy-json-migration-v1' AND NEW.value = 'complete'
      BEGIN SELECT RAISE(FAIL, 'migration state blocked'); END;
    `);
    database.close();

    const firstStore = openStore(dataDir);
    try {
      assert.equal(firstStore.status.usingJsonFallback, true);
      const profiles = new ProfileStore({
        getSecret: async () => undefined,
        setSecret: async () => undefined,
        deleteSecret: async () => undefined
      } as unknown as CredentialVault, {
        sqlite: firstStore,
        jsonStore: {
          read: async () => JSON.parse(await readFile(profilesPath, 'utf8')),
          write: async (value) => writeFile(profilesPath, JSON.stringify(value), 'utf8')
        }
      });
      await profiles.save({
        name: '回退后新增',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        authMethod: 'ssh_agent',
        connectTimeoutMs: 10_000,
        keepaliveIntervalMs: 15_000
      }, 'fallback-added');
    } finally {
      firstStore.close();
    }

    const repair = new Database(databasePath);
    repair.exec('DROP TRIGGER fail_migration_state');
    repair.close();

    const restarted = openStore(dataDir);
    try {
      assert.equal(restarted.status.usingJsonFallback, false, restarted.status.reason);
      assert.deepEqual(restarted.listProfiles().map(({ id }) => id), ['profile-1', 'fallback-added']);
      assert.equal(await readFile(`${profilesPath}.bak`, 'utf8'), originalProfiles);
      assert.match(await readFile(profilesPath, 'utf8'), /fallback-added/);
    } finally {
      restarted.close();
    }
  });
});

test('备份创建或只读设置失败且数据库未切换时安全回退 JSON', async () => {
  for (const failure of ['copy', 'chmod'] as const) {
    await withDataDir(async (dataDir) => {
      await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify([legacyProfile]), 'utf8');
      await writeFile(path.join(dataDir, 'history.json'), JSON.stringify([legacyRecord]), 'utf8');
      const store = openStore(dataDir, {
        backupOperations: failure === 'copy'
          ? { copyFile: () => { throw Object.assign(new Error('copy denied'), { code: 'EACCES' }); } }
          : { chmod: () => { throw Object.assign(new Error('chmod denied'), { code: 'EACCES' }); } }
      });
      try {
        assert.equal(store.status.usingJsonFallback, true, `${failure}: ${store.status.reason}`);
        assert.equal(store.status.migrationBlocked, false);
      } finally {
        store.close();
      }
    });
  }
});

test('备份操作失败但 SQLite 已导入或已有业务数据时阻断回退', async () => {
  await withDataDir(async (dataDir) => {
    const profilesPath = path.join(dataDir, 'profiles.json');
    const historyPath = path.join(dataDir, 'history.json');
    await writeFile(profilesPath, JSON.stringify([legacyProfile]), 'utf8');
    await writeFile(historyPath, JSON.stringify([legacyRecord]), 'utf8');
    const initial = openStore(dataDir);
    initial.close();

    const profileHash = createHash('sha256').update(await readFile(profilesPath)).digest('hex');
    const historyHash = createHash('sha256').update(await readFile(historyPath)).digest('hex');
    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'));
    database.prepare("UPDATE migration_state SET value = ? WHERE key = 'legacy-json-migration-v1'").run(
      `imported:${JSON.stringify({ profileHash, historyHash })}`
    );
    database.close();

    const imported = openStore(dataDir, {
      backupOperations: { chmod: () => { throw Object.assign(new Error('chmod denied'), { code: 'EACCES' }); } }
    });
    assert.equal(imported.status.usingJsonFallback, false);
    assert.equal(imported.status.migrationBlocked, true);
  });

  await withDataDir(async (dataDir) => {
    await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify([legacyProfile]), 'utf8');
    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'));
    database.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT, host TEXT, port INTEGER, username TEXT, auth_method TEXT, private_key_path TEXT, credential_id TEXT, private_key_passphrase_credential_id TEXT, connect_timeout_ms INTEGER, keepalive_interval_ms INTEGER, jump_host TEXT, created_at TEXT, updated_at TEXT)');
    database.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'existing', '已有数据', '127.0.0.1', 22, 'root', 'ssh_agent', null, null, null,
      10_000, 15_000, null, legacyProfile.createdAt, legacyProfile.updatedAt
    );
    database.close();

    const existing = openStore(dataDir, {
      backupOperations: { copyFile: () => { throw Object.assign(new Error('copy denied'), { code: 'EACCES' }); } }
    });
    assert.equal(existing.status.usingJsonFallback, false);
    assert.equal(existing.status.migrationBlocked, true);
  });
});

test('数据库未切换时允许从当前 JSON 迁移，且绝不覆盖已有不匹配的 .bak', async () => {
  await withDataDir(async (dataDir) => {
    const profilesPath = path.join(dataDir, 'profiles.json');
    const backupPath = `${profilesPath}.bak`;
    await writeFile(profilesPath, JSON.stringify([legacyProfile]), 'utf8');
    await writeFile(path.join(dataDir, 'history.json'), JSON.stringify([legacyRecord]), 'utf8');
    await writeFile(backupPath, '不可覆盖的旧备份', 'utf8');

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, false, store.status.reason);
    assert.equal(store.status.migrationBlocked, false);
    assert.deepEqual(store.listProfiles(), [legacyProfile]);
    assert.equal(await readFile(profilesPath, 'utf8'), JSON.stringify([legacyProfile]));
    assert.equal(await readFile(backupPath, 'utf8'), '不可覆盖的旧备份');
    store.close();
  });
});

test('重复 ID 导入失败时回退 JSON，且 SQLite 不留下部分导入的数据', async () => {
  await withDataDir(async (dataDir) => {
    const profilesPath = path.join(dataDir, 'profiles.json');
    const historyPath = path.join(dataDir, 'history.json');
    const profilesJson = JSON.stringify([legacyProfile, { ...legacyProfile, name: '重复 ID' }]);
    const historyJson = JSON.stringify([legacyRecord]);
    await writeFile(profilesPath, profilesJson, 'utf8');
    await writeFile(historyPath, historyJson, 'utf8');

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, true);
    assert.match(store.status.reason ?? '', /UNIQUE constraint failed/);
    assert.equal(await readFile(profilesPath, 'utf8'), profilesJson);
    assert.equal(await readFile(historyPath, 'utf8'), historyJson);
    assert.equal(await readFile(`${profilesPath}.bak`, 'utf8'), profilesJson);
    assert.equal(await readFile(`${historyPath}.bak`, 'utf8'), historyJson);
    store.close();

    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'), { readonly: true });
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM profiles').get() as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM command_history').get() as { count: number }).count, 0);
    database.close();
  });
});

test('导入时忽略 legacy JSON 中的密码和私钥口令', async () => {
  await withDataDir(async (dataDir) => {
    const password = 'never-store-this-password';
    const privateKeyPassphrase = 'never-store-this-passphrase';
    const profileWithSecrets = { ...legacyProfile, password, privateKeyPassphrase };
    await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify([profileWithSecrets]), 'utf8');
    await writeFile(path.join(dataDir, 'history.json'), JSON.stringify([legacyRecord]), 'utf8');

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, false);
    const [profile] = store.listProfiles();
    assert.equal('password' in profile, false);
    assert.equal('privateKeyPassphrase' in profile, false);
    for (const file of await readdir(dataDir)) {
      if (!file.startsWith('ai-ssh.sqlite')) continue;
      const contents = await readFile(path.join(dataDir, file));
      assert.equal(contents.includes(Buffer.from(password)), false, `${file} 包含密码`);
      assert.equal(contents.includes(Buffer.from(privateKeyPassphrase)), false, `${file} 包含私钥口令`);
    }
    store.close();
  });
});

test('旧 JSON 损坏时保持原文件不变并阻断迁移，不允许 JSON 写入', async () => {
  await withDataDir(async (dataDir) => {
    const profilesPath = path.join(dataDir, 'profiles.json');
    const historyPath = path.join(dataDir, 'history.json');
    await writeFile(profilesPath, '{坏掉的 JSON', 'utf8');
    await writeFile(historyPath, JSON.stringify([legacyRecord]), 'utf8');

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(store.status.migrationBlocked, true);
    assert.match(store.status.reason ?? '', /profiles\.json/);
    assert.equal(await readFile(profilesPath, 'utf8'), '{坏掉的 JSON');
    assert.equal(await readFile(historyPath, 'utf8'), JSON.stringify([legacyRecord]));
    await assert.rejects(stat(`${profilesPath}.bak`));
    await assert.rejects(stat(`${historyPath}.bak`));
    store.close();
  });
});

test('旧 imported(hash) 状态在备份不可信时阻断迁移且不允许 JSON 回退', async () => {
  await withDataDir(async (dataDir) => {
    const profilesPath = path.join(dataDir, 'profiles.json');
    const historyPath = path.join(dataDir, 'history.json');
    const profileJson = JSON.stringify([legacyProfile]);
    const historyJson = JSON.stringify([legacyRecord]);
    await writeFile(profilesPath, profileJson, 'utf8');
    await writeFile(historyPath, historyJson, 'utf8');
    await writeFile(`${profilesPath}.bak`, '不可信旧备份', 'utf8');

    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'));
    database.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, auth_method TEXT NOT NULL, private_key_path TEXT, credential_id TEXT, private_key_passphrase_credential_id TEXT, connect_timeout_ms INTEGER NOT NULL, keepalive_interval_ms INTEGER NOT NULL, jump_host TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE command_history (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, command TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, signal TEXT, stdout_tail TEXT NOT NULL, stderr_tail TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE migration_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    database.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      legacyProfile.id, legacyProfile.name, legacyProfile.host, legacyProfile.port, legacyProfile.username,
      legacyProfile.authMethod, null, legacyProfile.credentialId, null, legacyProfile.connectTimeoutMs,
      legacyProfile.keepaliveIntervalMs, null, legacyProfile.createdAt, legacyProfile.updatedAt
    );
    database.prepare('INSERT INTO command_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      legacyRecord.id, legacyRecord.sessionId, legacyRecord.command, legacyRecord.startedAt,
      legacyRecord.finishedAt, legacyRecord.exitCode, null, legacyRecord.stdoutTail,
      legacyRecord.stderrTail, legacyRecord.summary
    );
    const profileHash = createHash('sha256').update(profileJson).digest('hex');
    const historyHash = createHash('sha256').update(historyJson).digest('hex');
    database.prepare('INSERT INTO migration_state (key, value) VALUES (?, ?)').run(
      'legacy-json-migration-v1',
      `imported:${JSON.stringify({ profileHash, historyHash })}`
    );
    database.close();

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(store.status.migrationBlocked, true);
    assert.throws(() => store.assertWritable(), /备份|迁移/);
    store.close();
  });
});

test('旧 imported(hash) 状态与已导入业务数据不一致时阻断迁移，不回退 JSON', async () => {
  await withDataDir(async (dataDir) => {
    const profilesPath = path.join(dataDir, 'profiles.json');
    const historyPath = path.join(dataDir, 'history.json');
    await writeFile(profilesPath, JSON.stringify([legacyProfile]), 'utf8');
    await writeFile(historyPath, JSON.stringify([legacyRecord]), 'utf8');
    const initial = openStore(dataDir);
    initial.close();

    const profileHash = createHash('sha256').update(await readFile(profilesPath)).digest('hex');
    const historyHash = createHash('sha256').update(await readFile(historyPath)).digest('hex');
    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'));
    database.prepare("UPDATE migration_state SET value = ? WHERE key = 'legacy-json-migration-v1'").run(
      `imported:${JSON.stringify({ profileHash, historyHash })}`
    );
    database.prepare('DELETE FROM command_history').run();
    database.close();

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(store.status.migrationBlocked, true);
    assert.throws(() => store.assertWritable(), /校验|迁移/);
    store.close();
  });
});

test('两个真实 Node 进程并发迁移和写入时只使用 SQLite，不产生 JSON 分叉或丢记录', async () => {
  await withDataDir(async (dataDir) => {
    const legacyProfiles = Array.from({ length: 2000 }, (_, index) => ({
      ...legacyProfile,
      id: `legacy-${index}`,
      name: `旧配置 ${index}`,
      credentialId: `legacy-${index}:password`
    }));
    const profilesPath = path.join(dataDir, 'profiles.json');
    const historyPath = path.join(dataDir, 'history.json');
    const profilesJson = JSON.stringify(legacyProfiles);
    const historyJson = JSON.stringify([legacyRecord]);
    await writeFile(profilesPath, profilesJson, 'utf8');
    await writeFile(historyPath, historyJson, 'utf8');

    const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'concurrent-sqlite-worker.ts');
    const startFile = path.join(dataDir, 'start-workers');
    const launch = (workerId: string) => new Promise<{ child: ReturnType<typeof spawn>; done: Promise<void> }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, dataDir, workerId, startFile], {
        cwd: process.cwd(),
        env: { ...process.env, AI_SSH_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('READY')) {
          resolve({
            child,
            done: new Promise<void>((doneResolve, doneReject) => child.once('exit', (code) => {
              if (code === 0) doneResolve();
              else doneReject(new Error(`worker ${workerId} exited ${code}: ${stderr || stdout}`));
            }))
          });
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!stdout.includes('READY')) reject(new Error(`worker ${workerId} exited before ready (${code}): ${stderr || stdout}`));
      });
    });

    const [workerA, workerB] = await Promise.all([launch('worker-a'), launch('worker-b')]);
    await writeFile(startFile, 'go', 'utf8');
    await Promise.all([workerA.done, workerB.done]);

    assert.equal(await readFile(profilesPath, 'utf8'), profilesJson);
    assert.equal(await readFile(historyPath, 'utf8'), historyJson);
    assert.equal(await readFile(`${profilesPath}.bak`, 'utf8'), profilesJson);
    assert.equal(await readFile(`${historyPath}.bak`, 'utf8'), historyJson);
    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'), { readonly: true });
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM profiles').get() as { count: number }).count, 2002);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM profiles WHERE id IN ('worker-a', 'worker-b')").get() as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT value FROM migration_state WHERE key = 'legacy-json-migration-v1'").get() as { value: string }).value, 'complete');
    database.close();
  });
});

test('已有数据库被独占锁定时不回退 JSON，并以明确错误阻止存储访问', async () => {
  await withDataDir(async (dataDir) => {
    const databasePath = path.join(dataDir, 'ai-ssh.sqlite');
    const locker = new Database(databasePath);
    locker.exec('BEGIN EXCLUSIVE');

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(store.status.unavailable, true);
    assert.throws(() => store.listProfiles(), SqliteStoreUnavailableError);

    locker.exec('ROLLBACK');
    locker.close();

    assert.deepEqual(store.listProfiles(), []);
    const writableStore = store as unknown as { setMigrationState(value: string): void };
    writableStore.setMigrationState('complete');
    const verification = new Database(databasePath, { readonly: true });
    assert.equal(verification.prepare("SELECT value FROM migration_state WHERE key = 'legacy-json-migration-v1'").get()?.value, 'complete');
    verification.close();
    store.close();
  });
});

test('SQLITE_LOCKED 表锁错误也被识别为不可用，绝不触发 JSON 回退', () => {
  const isBusyError = (SqliteStore.prototype as unknown as {
    isBusyError(error: Error): boolean;
  }).isBusyError;
  assert.equal(isBusyError.call({}, new Error('SQLITE_LOCKED: database table is locked: profiles')), true);
});

test('已导入的哈希状态在源 JSON 被修改后阻止写入，而不会回退或删除数据库数据', async () => {
  await withDataDir(async (dataDir) => {
    const profilesPath = path.join(dataDir, 'profiles.json');
    const historyPath = path.join(dataDir, 'history.json');
    await writeFile(profilesPath, JSON.stringify([legacyProfile]), 'utf8');
    await writeFile(historyPath, JSON.stringify([legacyRecord]), 'utf8');

    const initial = openStore(dataDir);
    initial.close();

    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'));
    const profileHash = createHash('sha256').update(await readFile(profilesPath)).digest('hex');
    const historyHash = createHash('sha256').update(await readFile(historyPath)).digest('hex');
    database.prepare("UPDATE migration_state SET value = ? WHERE key = 'legacy-json-migration-v1'")
      .run(`imported:${JSON.stringify({ profileHash, historyHash })}`);
    database.close();
    await writeFile(profilesPath, JSON.stringify([{ ...legacyProfile, name: '被修改的来源' }]), 'utf8');

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(store.status.migrationBlocked, true);
    assert.deepEqual(store.listProfiles(), [legacyProfile]);
    assert.throws(() => store.assertWritable(), /迁移/);
    store.close();
  });
});

test('无迁移状态但已有业务数据时阻止迁移，绝不删除已有记录', async () => {
  await withDataDir(async (dataDir) => {
    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'));
    database.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT, host TEXT, port INTEGER, username TEXT, auth_method TEXT, private_key_path TEXT, credential_id TEXT, private_key_passphrase_credential_id TEXT, connect_timeout_ms INTEGER, keepalive_interval_ms INTEGER, jump_host TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE command_history (id TEXT PRIMARY KEY, session_id TEXT, command TEXT, started_at TEXT, finished_at TEXT, exit_code INTEGER, signal TEXT, stdout_tail TEXT, stderr_tail TEXT, summary TEXT);
    `);
    database.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('existing', '已有数据', '127.0.0.1', 22, 'root', 'ssh_agent', null, null, null, 10000, 15000, null, legacyProfile.createdAt, legacyProfile.updatedAt);
    database.close();
    await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify([legacyProfile]), 'utf8');

    const store = openStore(dataDir);
    assert.equal(store.status.migrationBlocked, true);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(store.listProfiles()[0]?.id, 'existing');
    store.close();
  });
});

test('未知 SQLite 用户表含数据时阻止迁移并保留外部数据', async () => {
  await withDataDir(async (dataDir) => {
    const profilesPath = path.join(dataDir, 'profiles.json');
    const legacyJson = JSON.stringify([legacyProfile]);
    await writeFile(profilesPath, legacyJson, 'utf8');

    const databasePath = path.join(dataDir, 'ai-ssh.sqlite');
    const database = new Database(databasePath);
    database.exec('CREATE TABLE external_tool_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.prepare('INSERT INTO external_tool_state (id, value) VALUES (?, ?)').run('keep', 'unchanged');
    database.close();

    const store = openStore(dataDir);
    assert.equal(store.status.migrationBlocked, true);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(await readFile(profilesPath, 'utf8'), legacyJson);
    assert.equal(store.listProfiles().length, 0);
    store.close();

    const verification = new Database(databasePath, { readonly: true });
    assert.deepEqual(verification.prepare('SELECT id, value FROM external_tool_state').get(), { id: 'keep', value: 'unchanged' });
    verification.close();
  });
});

test('非法 legacy 记录会阻断迁移且不会留下部分导入数据', async () => {
  await withDataDir(async (dataDir) => {
    await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify([legacyProfile, { ...legacyProfile, id: 'invalid', port: 0 }]), 'utf8');
    await writeFile(path.join(dataDir, 'history.json'), JSON.stringify([legacyRecord]), 'utf8');

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(store.status.migrationBlocked, true);
    store.close();

    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'), { readonly: true });
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM profiles').get() as { count: number }).count, 0);
    database.close();
  });
});

test('逐条校验历史记录的全部 Zod 字段，阻断无效记录且不留下导入数据', async () => {
  await withDataDir(async (dataDir) => {
    await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify([legacyProfile]), 'utf8');
    await writeFile(path.join(dataDir, 'history.json'), JSON.stringify([
      legacyRecord,
      { ...legacyRecord, id: 'invalid-history', exitCode: 1.5 }
    ]), 'utf8');

    const store = openStore(dataDir);
    assert.equal(store.status.usingJsonFallback, false);
    assert.equal(store.status.migrationBlocked, true);
    assert.match(store.status.reason ?? '', /历史|history/i);
    store.close();

    const database = new Database(path.join(dataDir, 'ai-ssh.sqlite'), { readonly: true });
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM profiles').get() as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM command_history').get() as { count: number }).count, 0);
    database.close();
  });
});
