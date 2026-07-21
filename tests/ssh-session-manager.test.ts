import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Client } from 'ssh2';

import { CredentialVault } from '../src/core/credential-vault';
import { HistoryStore } from '../src/core/history-store';
import { ProfileStore } from '../src/core/profile-store';
import { SshSessionManager } from '../src/core/ssh-session-manager';
import type { AuthorizationLevel, ConnectionProfile, CommandRecord } from '../src/shared/types';

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

  connect(): this {
    this.connectCalls += 1;
    queueMicrotask(() => this.emit('ready'));
    return this;
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

function createHarness(
  authorizationLevel: AuthorizationLevel,
  profileOverrides: Partial<ConnectionProfile> = {}
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
  const manager = new SshSessionManager(
    profiles,
    credentials,
    history,
    () => client as unknown as Client
  );

  return { client, historyRecords, manager, authorizationLevel };
}

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
