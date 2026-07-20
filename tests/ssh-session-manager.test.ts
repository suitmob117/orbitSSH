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
  execCalls = 0;
  sftpCalls = 0;
  readonly operations: string[] = [];

  connect(): this {
    queueMicrotask(() => this.emit('ready'));
    return this;
  }

  exec(_command: string, callback: (error: Error | undefined, stream: FakeChannel) => void): void {
    this.execCalls += 1;
    this.operations.push('exec');
    const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    callback(undefined, stream);
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
    const complete = (done: (error?: Error) => void) => queueMicrotask(() => done());
    callback(undefined, {
      end() {},
      fastPut(_localPath, _remotePath, done) {
        complete(done);
      },
      fastGet(_remotePath, _localPath, done) {
        complete(done);
      }
    });
  }
}

function createHarness(authorizationLevel: AuthorizationLevel) {
  const client = new FakeClient();
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
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
  const profiles = { get: async () => profile } as unknown as ProfileStore;
  const credentials = { getSecret: async () => 'password' } as unknown as CredentialVault;
  const history = {
    append: async (record: Omit<CommandRecord, 'id'>): Promise<CommandRecord> => {
      client.operations.push('history');
      return { id: 'record-1', ...record };
    }
  } as unknown as HistoryStore;
  const manager = new SshSessionManager(
    profiles,
    credentials,
    history,
    () => client as unknown as Client
  );

  return { client, manager, authorizationLevel };
}

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
