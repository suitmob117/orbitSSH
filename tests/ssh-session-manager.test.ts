import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Client } from 'ssh2';

import { CredentialVault } from '../src/core/credential-vault';
import { HistoryStore } from '../src/core/history-store';
import { ProfileStore } from '../src/core/profile-store';
import { SshSessionManager } from '../src/core/ssh-session-manager';
import type { HostKeyStorePort } from '../src/core/host-key-store';
import type { FileBoundaryPort } from '../src/core/file-boundary';
import type {
  AuthorizationLevel,
  ConnectionProfile,
  ConnectionProfileInput,
  CommandRecord,
  HostKeyTrustChallenge,
  TrustedHostKey
} from '../src/shared/types';

type FakeChannel = EventEmitter & { stderr: EventEmitter };

class FakeClient extends EventEmitter {
  connectCalls = 0;
  execCalls = 0;
  sftpCalls = 0;
  execError?: Error;
  sftpError?: Error;
  fastPutError?: Error;
  fastGetError?: Error;
  readonly operations: string[] = [];
  readonly executedCommands: string[] = [];
  presentedHostKey?: Buffer;
  synchronousHostVerification = false;
  deferHostVerificationError = false;
  delayReady = false;
  readyError?: Error;
  private readyPending = false;

  connect(config?: { hostVerifier?: (key: Buffer) => boolean }): this {
    this.connectCalls += 1;
    const verifyHostKey = () => !this.presentedHostKey || !config?.hostVerifier || config.hostVerifier(this.presentedHostKey);
    if (this.synchronousHostVerification && !verifyHostKey()) {
      const rejectVerification = () => this.emit('error', new Error('Host verification failed'));
      if (this.deferHostVerificationError) setImmediate(rejectVerification);
      else queueMicrotask(rejectVerification);
      return this;
    }
    queueMicrotask(() => {
      if (!this.synchronousHostVerification && !verifyHostKey()) {
        this.emit('error', new Error('Host verification failed'));
        return;
      }
      if (this.delayReady) {
        this.readyPending = true;
        return;
      }
      this.emit('ready');
    });
    return this;
  }

  releaseReady(): void {
    if (!this.readyPending) throw new Error('没有等待中的连接');
    this.readyPending = false;
    if (this.readyError) this.emit('error', this.readyError);
    else this.emit('ready');
  }

  end(): void {
    this.emit('close');
  }

  exec(command: string, callback: (error: Error | undefined, stream: FakeChannel) => void): void {
    this.execCalls += 1;
    this.operations.push('exec');
    this.executedCommands.push(command);
    const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    callback(this.execError, stream);
    if (this.execError) {
      return;
    }
    queueMicrotask(() => {
      stream.emit('data', Buffer.from('ok'));
      stream.emit('close', 0, '');
    });
  }

  sftp(
    callback: (
      error: Error | undefined,
      sftp: {
        end(): void;
        fastPut(_localPath: string, _remotePath: string, done: (error?: Error) => void): void;
        fastGet(_remotePath: string, _localPath: string, done: (error?: Error) => void): void;
      }
    ) => void
  ): void {
    this.sftpCalls += 1;
    this.operations.push('sftp');
    const fastPutError = this.fastPutError;
    const fastGetError = this.fastGetError;
    const complete = (done: (error?: Error) => void, error?: Error) =>
      queueMicrotask(() => done(error));
    callback(this.sftpError, {
      end() {},
      fastPut(_localPath, _remotePath, done) {
        complete(done, fastPutError);
      },
      fastGet(_remotePath, _localPath, done) {
        complete(done, fastGetError);
      }
    });
  }
}

class MemoryHostKeyStore implements HostKeyStorePort {
  private readonly records = new Map<string, TrustedHostKey>();

  get(profileId: string): TrustedHostKey | undefined {
    return this.records.get(profileId);
  }

  confirm(challenge: HostKeyTrustChallenge): TrustedHostKey {
    const existing = this.records.get(challenge.profileId);
    if (challenge.risk === 'changed' && existing?.fingerprint !== challenge.oldFingerprint) {
      throw new Error('主机指纹确认信息已过期');
    }
    const now = new Date().toISOString();
    const record: TrustedHostKey = {
      profileId: challenge.profileId,
      host: challenge.host,
      port: challenge.port,
      fingerprint: challenge.newFingerprint,
      trustedAt: existing?.trustedAt ?? now,
      updatedAt: now
    };
    this.records.set(record.profileId, record);
    return record;
  }
}

function createHarness(
  authorizationLevel: AuthorizationLevel,
  profileOverrides: Partial<ConnectionProfile> = {},
  fileBoundary: FileBoundaryPort = { resolve: async ({ localPath, remotePath }) => ({ localPath, remotePath }) }
) {
  const client = new FakeClient();
  const historyRecords: Omit<CommandRecord, 'id'>[] = [];
  const profile: ConnectionProfile = {
    id: 'profile-1',
    name: 'Test remote server',
    host: '127.0.0.1',
    port: 1,
    username: 'tester',
    authMethod: 'saved_password',
    credentialId: 'credential-1',
    connectTimeoutMs: 1000,
    keepaliveIntervalMs: 1000,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...profileOverrides
  };
  const profiles = { get: async () => profile } as unknown as ProfileStore;
  const credentials = { getSecret: async () => 'password' } as unknown as CredentialVault;
  const history = {
    append: async (record: Omit<CommandRecord, 'id'>): Promise<CommandRecord> => {
      client.operations.push('history');
      historyRecords.push(record);
      return { id: 'record-1', ...record };
    }
  } as unknown as HistoryStore;
  const hostKeys = new MemoryHostKeyStore();
  const manager = new SshSessionManager(
    profiles,
    credentials,
    history,
    hostKeys,
    () => client as unknown as Client,
    () => fileBoundary
  );

  return { client, historyRecords, hostKeys, manager, profile, authorizationLevel };
}

test('未知 SSH 主机指纹在握手前被拒绝，桌面确认后才允许连接', async () => {
  const harness = createHarness('ask_every_time');
  harness.client.presentedHostKey = Buffer.from('first-host-key');

  await assert.rejects(harness.manager.openSession('profile-1', harness.authorizationLevel), /主机指纹.*拒绝/);
  const [challenge] = harness.manager.listHostKeyTrustChallenges();
  assert.equal(typeof challenge?.challengeId, 'string');
  assert.deepEqual({ ...challenge, challengeId: undefined }, {
    challengeId: undefined,
    profileId: 'profile-1',
    host: '127.0.0.1',
    port: 1,
    oldFingerprint: undefined,
    newFingerprint: 'SHA256:9XmCuRCptekjpF34TFoLuTZhApSnWO8kiq1FaShUfUk=',
    risk: 'first_seen'
  });
  assert.equal(harness.hostKeys.get('profile-1'), undefined);

  await harness.manager.confirmHostKeyTrust({ profileId: challenge!.profileId, challengeId: challenge!.challengeId });
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  assert.equal(session.health, 'connected');
});

test('同步 hostVerifier 回调也会创建待确认挑战并在握手前拒绝', async () => {
  const harness = createHarness('ask_every_time');
  harness.client.presentedHostKey = Buffer.from('first-host-key');
  harness.client.synchronousHostVerification = true;

  await assert.rejects(harness.manager.openSession('profile-1', harness.authorizationLevel), /未知 SSH 主机指纹/);
  assert.equal(harness.manager.listHostKeyTrustChallenges().length, 1);
});

test('同一配置的并发连接复用单次握手，新一轮挑战会使旧令牌过期', async () => {
  const harness = createHarness('ask_every_time');
  harness.client.presentedHostKey = Buffer.from('first-host-key');
  harness.client.synchronousHostVerification = true;
  harness.client.deferHostVerificationError = true;
  const firstAttempt = harness.manager.openSession('profile-1', harness.authorizationLevel);
  for (let index = 0; index < 4 && harness.manager.listHostKeyTrustChallenges().length === 0; index += 1) {
    await Promise.resolve();
  }
  const first = harness.manager.listHostKeyTrustChallenges()[0]!;
  const secondAttempt = harness.manager.openSession('profile-1', harness.authorizationLevel);
  await Promise.allSettled([firstAttempt, secondAttempt]);
  assert.equal(harness.client.connectCalls, 1);

  const retry = harness.manager.openSession('profile-1', harness.authorizationLevel);
  for (let index = 0; index < 4 && harness.manager.listHostKeyTrustChallenges()[0]?.challengeId === first.challengeId; index += 1) {
    await Promise.resolve();
  }
  const second = harness.manager.listHostKeyTrustChallenges()[0]!;
  await Promise.allSettled([retry]);

  assert.notEqual(first.challengeId, second.challengeId);
  await assert.rejects(
    harness.manager.confirmHostKeyTrust({ profileId: first.profileId, challengeId: first.challengeId }),
    /没有匹配|过期/
  );
  await harness.manager.confirmHostKeyTrust({ profileId: second.profileId, challengeId: second.challengeId });
  assert.equal(harness.hostKeys.get('profile-1')?.fingerprint, second.newFingerprint);
});

test('配置端点变化或删除待确认项后，旧挑战不可确认', async () => {
  const harness = createHarness('ask_every_time');
  harness.client.presentedHostKey = Buffer.from('first-host-key');
  await assert.rejects(harness.manager.openSession('profile-1', harness.authorizationLevel));
  const changedEndpoint = harness.manager.listHostKeyTrustChallenges()[0]!;
  harness.profile.host = 'new-host.example.com';
  await assert.rejects(
    harness.manager.confirmHostKeyTrust({ profileId: changedEndpoint.profileId, challengeId: changedEndpoint.challengeId }),
    /主机或端口已变化/
  );
  assert.equal(harness.manager.listHostKeyTrustChallenges().length, 0);

  harness.profile.host = '127.0.0.1';
  await assert.rejects(harness.manager.openSession('profile-1', harness.authorizationLevel));
  const deleted = harness.manager.listHostKeyTrustChallenges()[0]!;
  harness.manager.discardPendingHostKeyChallenge('profile-1');
  await assert.rejects(
    harness.manager.confirmHostKeyTrust({ profileId: deleted.profileId, challengeId: deleted.challengeId }),
    /没有匹配/
  );
});

test('存在活跃会话时拒绝修改主机端口或删除配置，关闭后恢复可操作', async () => {
  const harness = createHarness('ask_every_time');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  const edited: Pick<ConnectionProfileInput, 'host' | 'port'> = { host: 'new-host.example.com', port: 2222 };

  assert.throws(() => harness.manager.assertProfileCanBeUpdated('profile-1', edited), /先关闭会话/);
  assert.throws(() => harness.manager.assertProfileCanBeDeleted('profile-1'), /先关闭会话/);
  assert.equal(harness.manager.listSessions()[0]?.id, session.id);

  await harness.manager.closeSession(session.id);
  assert.doesNotThrow(() => harness.manager.assertProfileCanBeUpdated('profile-1', edited));
  assert.doesNotThrow(() => harness.manager.assertProfileCanBeDeleted('profile-1'));
});

test('保存配置后丢弃待确认主机指纹，旧确认令牌不可复用', async () => {
  const harness = createHarness('ask_every_time');
  harness.client.presentedHostKey = Buffer.from('first-host-key');
  await assert.rejects(harness.manager.openSession('profile-1', harness.authorizationLevel));
  const challenge = harness.manager.listHostKeyTrustChallenges()[0]!;

  harness.manager.discardHostKeyChallenge('profile-1');
  assert.equal(harness.manager.listHostKeyTrustChallenges().length, 0);
  await assert.rejects(
    harness.manager.confirmHostKeyTrust({ profileId: challenge.profileId, challengeId: challenge.challengeId }),
    /没有匹配/
  );
});

test('连接进行中也锁定配置端点和删除，可信握手完成或失败后释放锁定', async () => {
  const harness = createHarness('ask_every_time');
  const trustedFingerprint = 'SHA256:9XmCuRCptekjpF34TFoLuTZhApSnWO8kiq1FaShUfUk=';
  harness.hostKeys.confirm({
    challengeId: '00000000-0000-4000-8000-000000000003',
    profileId: 'profile-1',
    host: '127.0.0.1',
    port: 1,
    newFingerprint: trustedFingerprint,
    risk: 'first_seen'
  });
  harness.client.presentedHostKey = Buffer.from('first-host-key');
  harness.client.delayReady = true;
  const opening = harness.manager.openSession('profile-1', harness.authorizationLevel);

  assert.throws(
    () => harness.manager.assertProfileCanBeUpdated('profile-1', { host: 'new-host.example.com', port: 22 }),
    /正在建立/
  );
  assert.throws(() => harness.manager.assertProfileCanBeDeleted('profile-1'), /正在建立/);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  harness.client.releaseReady();
  const session = await opening;
  assert.throws(() => harness.manager.assertProfileCanBeDeleted('profile-1'), /活跃/);
  await harness.manager.closeSession(session.id);
  assert.doesNotThrow(() => harness.manager.assertProfileCanBeDeleted('profile-1'));

  const failed = createHarness('ask_every_time');
  failed.client.delayReady = true;
  failed.client.readyError = new Error('connection failed');
  const failedOpening = failed.manager.openSession('profile-1', failed.authorizationLevel);
  assert.throws(() => failed.manager.assertProfileCanBeDeleted('profile-1'), /正在建立/);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  failed.client.releaseReady();
  await assert.rejects(failedOpening);
  assert.doesNotThrow(() => failed.manager.assertProfileCanBeDeleted('profile-1'));
});

test('变化的 SSH 主机指纹保持旧信任不变，明确替换后才允许连接', async () => {
  const harness = createHarness('ask_every_time');
  harness.client.presentedHostKey = Buffer.from('first-host-key');
  await assert.rejects(harness.manager.openSession('profile-1', harness.authorizationLevel));
  const firstChallenge = harness.manager.listHostKeyTrustChallenges()[0]!;
  await harness.manager.confirmHostKeyTrust({ profileId: firstChallenge.profileId, challengeId: firstChallenge.challengeId });
  const firstSession = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  await harness.manager.closeSession(firstSession.id);

  harness.client.presentedHostKey = Buffer.from('changed-host-key');
  await assert.rejects(harness.manager.openSession('profile-1', harness.authorizationLevel), /已变化.*拒绝/);
  const [challenge] = harness.manager.listHostKeyTrustChallenges();
  assert.equal(harness.hostKeys.get('profile-1')?.fingerprint, 'SHA256:9XmCuRCptekjpF34TFoLuTZhApSnWO8kiq1FaShUfUk=');
  assert.equal(challenge?.risk, 'changed');
  assert.equal(challenge?.oldFingerprint, 'SHA256:9XmCuRCptekjpF34TFoLuTZhApSnWO8kiq1FaShUfUk=');

  await harness.manager.confirmHostKeyTrust({ profileId: challenge!.profileId, challengeId: challenge!.challengeId });
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  assert.equal(session.health, 'connected');
});

test('redacts private-key configuration errors before attempting an SSH connection', async () => {
  const privateKeyPath = `${process.cwd()}\\missing-password=hunter2-private-key`;
  const harness = createHarness('ask_every_time', {
    authMethod: 'private_key',
    privateKeyPath
  });

  await assert.rejects(harness.manager.openSession('profile-1', harness.authorizationLevel), (error: Error) => {
    assert.equal(error.message.includes('hunter2'), false);
    assert.equal(error.message.includes('[REDACTED]'), true);
    return true;
  });

  assert.equal(harness.client.connectCalls, 0);
});

test('auto readonly rejects writes before remote execution and history recording', async () => {
  const harness = createHarness('auto_readonly');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  const commandSecret = 'command-secret-value';

  await assert.rejects(
    harness.manager.runCommand(session.id, `mkdir /tmp/${commandSecret}`),
    (error: Error) => {
      assert.equal(error.message.includes(commandSecret), false);
      return /当前会话为“只读自动”/.test(error.message);
    }
  );

  assert.equal(harness.client.execCalls, 0);
  assert.deepEqual(harness.client.operations, []);
});

test('auto readonly rejects readonly-prefix lookalikes before remote execution and history recording', async () => {
  const harness = createHarness('auto_readonly');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);

  await assert.rejects(harness.manager.runCommand(session.id, 'ls=shadowed python mutate.py'));

  assert.equal(harness.client.execCalls, 0);
  assert.equal(harness.historyRecords.length, 0);
  assert.deepEqual(harness.client.operations, []);
});

test('auto readonly rejects uploads before opening SFTP without exposing paths', async () => {
  const harness = createHarness('auto_readonly');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  const localPath = '/local/local-secret-value';
  const remotePath = '/remote/remote-secret-value';

  await assert.rejects(
    harness.manager.transferFile({
      sessionId: session.id,
      direction: 'upload',
      localPath,
      remotePath
    }),
    (error: Error) => {
      assert.equal(error.message.includes(localPath), false);
      assert.equal(error.message.includes(remotePath), false);
      return /已拒绝文件上传/.test(error.message);
    }
  );

  assert.equal(harness.client.sftpCalls, 0);
  assert.deepEqual(harness.client.operations, []);
});

test('路径检查失败时在打开 SFTP 前拒绝传输', async () => {
  const fileBoundary: FileBoundaryPort = {
    resolve: async () => {
      throw new Error('本地文件路径不在允许目录内');
    }
  };
  const harness = createHarness('ask_every_time', {}, fileBoundary);
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);

  await assert.rejects(
    harness.manager.transferFile({
      sessionId: session.id,
      direction: 'upload',
      localPath: '/local/report.txt',
      remotePath: '/srv/app/report.txt'
    }),
    /允许目录/
  );
  assert.equal(harness.client.sftpCalls, 0);
});

test('auto readonly allows readonly commands and downloads through remote interfaces', async () => {
  const harness = createHarness('auto_readonly');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);

  await harness.manager.runCommand(session.id, 'df -h');
  await harness.manager.transferFile({
    sessionId: session.id,
    direction: 'download',
    localPath: '/local/report.txt',
    remotePath: '/remote/report.txt'
  });

  assert.equal(harness.client.execCalls, 1);
  assert.equal(harness.client.sftpCalls, 1);
  assert.deepEqual(harness.client.operations, ['exec', 'history', 'sftp']);
});

test('command secrets are redacted from history without changing remote execution', async () => {
  const harness = createHarness('ask_every_time');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  const command = 'echo password=hunter2';

  const result = await harness.manager.runCommand(session.id, command);

  assert.deepEqual(harness.client.executedCommands, [command]);
  assert.equal(harness.historyRecords[0]?.command, 'echo password=[REDACTED]');
  assert.equal(result.record.command, 'echo password=[REDACTED]');
});

test('sensitive headers reach SSH unchanged but fail closed in command history', async () => {
  const harness = createHarness('ask_every_time');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  const secret = 'abc.def-123';
  const command = `curl -H "Authorization: Bearer ${secret}" /`;

  const result = await harness.manager.runCommand(session.id, command);

  assert.deepEqual(harness.client.executedCommands, [command]);
  assert.equal(harness.historyRecords[0]?.command, '[REDACTED:SENSITIVE_COMMAND]');
  assert.equal(result.record.command, '[REDACTED:SENSITIVE_COMMAND]');
  assert.equal(JSON.stringify(harness.historyRecords).includes(secret), false);
  assert.equal(JSON.stringify(result.record).includes(secret), false);
});

test('redacts secrets from command execution errors', async () => {
  const harness = createHarness('ask_every_time');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  harness.client.execError = new Error('password=hunter2');

  await assert.rejects(harness.manager.runCommand(session.id, 'echo hello'), (error: Error) => {
    assert.equal(error.message.includes('hunter2'), false);
    assert.equal(error.message.includes('[REDACTED]'), true);
    return true;
  });
});

test('redacts secrets from SFTP initialization errors', async () => {
  const harness = createHarness('ask_every_time');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  harness.client.sftpError = new Error('token=abc123');

  await assert.rejects(
    harness.manager.transferFile({
      sessionId: session.id,
      direction: 'upload',
      localPath: '/local/report.txt',
      remotePath: '/remote/report.txt'
    }),
    (error: Error) => {
      assert.equal(error.message.includes('abc123'), false);
      assert.equal(error.message.includes('[REDACTED]'), true);
      return true;
    }
  );
});

test('redacts secrets from SFTP transfer callback errors', async () => {
  const harness = createHarness('ask_every_time');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  harness.client.fastPutError = new Error('token=abc123');

  await assert.rejects(
    harness.manager.transferFile({
      sessionId: session.id,
      direction: 'upload',
      localPath: '/local/report.txt',
      remotePath: '/remote/report.txt'
    }),
    (error: Error) => {
      assert.equal(error.message.includes('abc123'), false);
      assert.equal(error.message.includes('[REDACTED]'), true);
      return true;
    }
  );
});

test('redacts command errors stored on session health checks', async () => {
  const harness = createHarness('ask_every_time');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);
  harness.client.execError = new Error('password=hunter2');

  const health = await harness.manager.getHealth(session.id);

  assert.equal(health.lastError?.includes('hunter2'), false);
  assert.equal(health.lastError?.includes('[REDACTED]'), true);
});

for (const authorizationLevel of ['ask_every_time', 'trusted_session'] as const) {
  test(`${authorizationLevel} allows writes and uploads through remote interfaces`, async () => {
    const harness = createHarness(authorizationLevel);
    const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);

    await harness.manager.runCommand(session.id, 'mkdir /tmp/demo');
    await harness.manager.transferFile({
      sessionId: session.id,
      direction: 'upload',
      localPath: '/local/demo.txt',
      remotePath: '/remote/demo.txt'
    });

    assert.equal(harness.client.execCalls, 1);
    assert.equal(harness.client.sftpCalls, 1);
    assert.deepEqual(harness.client.operations, ['exec', 'history', 'sftp']);
  });
}

test('trusted sessions reject high risk commands before remote execution and history recording', async () => {
  const harness = createHarness('trusted_session');
  const session = await harness.manager.openSession('profile-1', harness.authorizationLevel);

  await assert.rejects(
    harness.manager.runCommand(session.id, 'rm -rf /tmp/demo'),
    /高危操作仍需逐次审批.*每次询问/
  );

  assert.equal(harness.client.execCalls, 0);
  assert.equal(harness.historyRecords.length, 0);
  assert.deepEqual(harness.client.operations, []);
});
