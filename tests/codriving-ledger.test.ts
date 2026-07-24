import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CodrivingCoordinator,
  type CodrivingExecutionPort
} from '../src/core/codriving-coordinator';
import { SqliteStore } from '../src/core/sqlite-store';
import type {
  AuthorizationLevel,
  CommandResult,
  ConnectionSession,
  FileTransferRequest,
  FileTransferResult
} from '../src/shared/types';

class LedgerExecutionPort implements CodrivingExecutionPort {
  readonly commands: string[] = [];
  allowExecution = false;
  readonly session: ConnectionSession = {
    id: 'session-ledger',
    profileId: 'profile-ledger',
    profileName: '账本测试',
    health: 'connected',
    authorizationLevel: 'ask_every_time',
    openedAt: '2026-07-24T08:00:00.000Z'
  };

  getSession(): ConnectionSession {
    return this.session;
  }

  setAuthorizationLevel(_sessionId: string, level: AuthorizationLevel): ConnectionSession {
    this.session.authorizationLevel = level;
    return this.session;
  }

  async executeCommand(_sessionId: string, command: string): Promise<CommandResult> {
    if (!this.allowExecution) throw new Error('测试不应执行未恢复的待审批命令');
    this.commands.push(command);
    return {
      record: {
        id: 'record-ledger',
        sessionId: this.session.id,
        command,
        startedAt: '2026-07-24T08:00:00.000Z',
        finishedAt: '2026-07-24T08:00:01.000Z',
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        summary: '完成'
      },
      stdout: '',
      stderr: ''
    };
  }

  async executeFileTransfer(_request: FileTransferRequest): Promise<FileTransferResult> {
    throw new Error('测试不应执行文件传输');
  }
}

test('Runtime 重启后保留脱敏轨迹，并把无法安全恢复的待审批动作标记为已中断', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'orbitssh-codriving-ledger-'));
  let firstStore: SqliteStore | undefined;
  let restartedStore: SqliteStore | undefined;
  try {
    firstStore = new SqliteStore(dataDir);
    const first = new CodrivingCoordinator(new LedgerExecutionPort(), { ledger: firstStore });
    const pending = await first.requestCommand({
      sessionId: 'session-ledger',
      actor: 'codex',
      command: 'curl -H "Authorization: Bearer super-secret-token" https://example.invalid'
    });
    assert.equal(pending.action.status, 'pending_approval');
    firstStore.close();

    restartedStore = new SqliteStore(dataDir);
    const restarted = new CodrivingCoordinator(new LedgerExecutionPort(), { ledger: restartedStore });
    const restored = restarted.listEvents('session-ledger');

    assert.equal(restored.at(-1)?.id, pending.action.id);
    assert.equal(restored.at(-1)?.status, 'interrupted');
    assert.doesNotMatch(restored.at(-1)?.summary ?? '', /super-secret-token/);
    await assert.rejects(
      restarted.approveAction({ actionId: pending.action.id, digest: pending.action.digest }),
      /失效|不匹配/
    );
  } finally {
    firstStore?.close();
    restartedStore?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Runtime 状态恢复时保留仍有效的信任期限和用户接管状态', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'orbitssh-codriving-state-'));
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(dataDir);
    const firstExecution = new LedgerExecutionPort();
    const first = new CodrivingCoordinator(firstExecution, { ledger: store });
    first.setAuthorizationLevel({
      sessionId: firstExecution.session.id,
      authorizationLevel: 'trusted_session',
      trustedUntil: '2099-01-01T00:00:00.000Z'
    });
    store.close();

    store = new SqliteStore(dataDir);
    const restartedExecution = new LedgerExecutionPort();
    restartedExecution.allowExecution = true;
    const restarted = new CodrivingCoordinator(restartedExecution, { ledger: store });
    const submission = await restarted.requestCommand({
      sessionId: restartedExecution.session.id,
      actor: 'codex',
      command: 'pwd'
    });
    assert.equal(submission.action.status, 'completed');
    assert.deepEqual(restartedExecution.commands, ['pwd']);

    restarted.pauseCodex(restartedExecution.session.id);
    store.close();
    store = new SqliteStore(dataDir);
    const attached = new CodrivingCoordinator(new LedgerExecutionPort(), { ledger: store });
    assert.equal(attached.isCodexPaused(restartedExecution.session.id), true);
  } finally {
    store?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
