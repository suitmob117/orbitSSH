import assert from 'node:assert/strict';
import test from 'node:test';

import { CodrivingCoordinator, type CodrivingExecutionPort } from '../src/core/codriving-coordinator';
import type { CommandResult, ConnectionSession, FileTransferRequest, FileTransferResult } from '../src/shared/types';

function commandResult(command: string): CommandResult {
  return {
    record: {
      id: 'record-1',
      sessionId: 'session-1',
      command,
      startedAt: '2026-07-24T00:00:00.000Z',
      finishedAt: '2026-07-24T00:00:01.000Z',
      exitCode: 0,
      stdoutTail: 'ok',
      stderrTail: '',
      summary: 'ok'
    },
    stdout: 'ok',
    stderr: ''
  };
}

class FakeExecutionPort implements CodrivingExecutionPort {
  readonly commands: string[] = [];
  readonly transfers: FileTransferRequest[] = [];
  commandError?: Error;
  readonly session: ConnectionSession = {
    id: 'session-1',
    profileId: 'profile-1',
    profileName: '测试服务器',
    health: 'connected',
    authorizationLevel: 'ask_every_time',
    openedAt: '2026-07-24T00:00:00.000Z'
  };

  getSession(sessionId: string): ConnectionSession {
    assert.equal(sessionId, this.session.id);
    return this.session;
  }

  setAuthorizationLevel(sessionId: string, authorizationLevel: ConnectionSession['authorizationLevel']): ConnectionSession {
    assert.equal(sessionId, this.session.id);
    this.session.authorizationLevel = authorizationLevel;
    return this.session;
  }

  async executeCommand(sessionId: string, command: string): Promise<CommandResult> {
    assert.equal(sessionId, this.session.id);
    this.commands.push(command);
    if (this.commandError) throw this.commandError;
    return commandResult(command);
  }

  async executeFileTransfer(request: FileTransferRequest): Promise<FileTransferResult> {
    this.transfers.push(request);
    return {
      id: 'transfer-1',
      direction: request.direction,
      localPath: request.localPath,
      remotePath: request.remotePath,
      startedAt: '2026-07-24T00:00:00.000Z',
      finishedAt: '2026-07-24T00:00:01.000Z'
    };
  }
}

test('每次询问模式下 Codex 命令先形成待审批动作，不直接执行', async () => {
  const execution = new FakeExecutionPort();
  const coordinator = new CodrivingCoordinator(execution, {
    id: () => 'action-1',
    now: () => new Date('2026-07-24T00:00:00.000Z')
  });

  const submission = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'df -h'
  });

  assert.equal(submission.action.status, 'pending_approval');
  assert.equal(submission.action.actor, 'codex');
  assert.equal(submission.action.risk, 'readonly');
  assert.deepEqual(execution.commands, []);
});

test('自动只读模式只自动执行明确的只读命令', async () => {
  const execution = new FakeExecutionPort();
  execution.session.authorizationLevel = 'auto_readonly';
  const coordinator = new CodrivingCoordinator(execution);

  const readonly = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'df -h'
  });
  const write = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'mkdir /tmp/orbitssh-demo'
  });

  assert.equal(readonly.action.status, 'completed');
  assert.equal(write.action.status, 'pending_approval');
  assert.deepEqual(execution.commands, ['df -h']);
});

test('信任会话到期后自动降级为每次询问', async () => {
  const execution = new FakeExecutionPort();
  let now = new Date('2026-07-24T00:00:00.000Z');
  const coordinator = new CodrivingCoordinator(execution, { now: () => now });
  coordinator.setAuthorizationLevel({
    sessionId: execution.session.id,
    authorizationLevel: 'trusted_session',
    trustedUntil: '2026-07-24T00:30:00.000Z'
  });

  const beforeExpiry = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'mkdir /tmp/orbitssh-demo'
  });
  now = new Date('2026-07-24T00:31:00.000Z');
  const afterExpiry = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'df -h'
  });

  assert.equal(beforeExpiry.action.status, 'completed');
  assert.equal(afterExpiry.action.status, 'pending_approval');
  assert.equal(execution.session.authorizationLevel, 'ask_every_time');
});

test('批准动作只执行创建审批时绑定的原命令', async () => {
  const execution = new FakeExecutionPort();
  const coordinator = new CodrivingCoordinator(execution);
  const submission = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'uname -a'
  });

  const approved = await coordinator.approveAction({
    actionId: submission.action.id,
    digest: submission.action.digest
  });

  assert.equal(approved.action.status, 'completed');
  assert.deepEqual(execution.commands, ['uname -a']);
});

test('审批摘要不匹配时拒绝执行', async () => {
  const execution = new FakeExecutionPort();
  const coordinator = new CodrivingCoordinator(execution);
  const submission = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'uname -a'
  });

  await assert.rejects(
    coordinator.approveAction({ actionId: submission.action.id, digest: 'tampered' }),
    /审批已失效或与待执行动作不匹配/
  );
  assert.deepEqual(execution.commands, []);
});

test('用户接管会暂停新的 Codex 动作，但不影响用户直接操作', async () => {
  const execution = new FakeExecutionPort();
  execution.session.authorizationLevel = 'trusted_session';
  const coordinator = new CodrivingCoordinator(execution);
  coordinator.pauseCodex(execution.session.id);

  const codex = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'df -h'
  });
  const user = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'user',
    command: 'pwd'
  });

  assert.equal(codex.action.status, 'paused');
  assert.equal(user.action.status, 'completed');
  assert.deepEqual(execution.commands, ['pwd']);
});

test('高危护栏同时约束用户和信任会话中的 Codex', async () => {
  const execution = new FakeExecutionPort();
  let sequence = 0;
  const coordinator = new CodrivingCoordinator(execution, { id: () => `action-${++sequence}` });
  coordinator.setAuthorizationLevel({
    sessionId: execution.session.id,
    authorizationLevel: 'trusted_session',
    trustedUntil: '2099-01-01T00:00:00.000Z'
  });

  const user = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'user',
    command: 'rm -rf /'
  });
  coordinator.rejectAction({ actionId: user.action.id, digest: user.action.digest });
  const codex = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'rm -rf /'
  });

  assert.equal(user.action.status, 'pending_approval');
  assert.equal(codex.action.status, 'pending_approval');
  assert.deepEqual(execution.commands, []);
});

test('自动只读模式允许 Codex 下载，但上传必须审批', async () => {
  const execution = new FakeExecutionPort();
  execution.session.authorizationLevel = 'auto_readonly';
  const coordinator = new CodrivingCoordinator(execution);
  const download: FileTransferRequest = {
    sessionId: execution.session.id,
    direction: 'download',
    localPath: 'C:\\safe\\app.log',
    remotePath: '/opt/app.log'
  };
  const upload: FileTransferRequest = {
    sessionId: execution.session.id,
    direction: 'upload',
    localPath: 'C:\\safe\\app.conf',
    remotePath: '/opt/app.conf'
  };

  const downloaded = await coordinator.requestFileTransfer({ actor: 'codex', request: download });
  const uploaded = await coordinator.requestFileTransfer({ actor: 'codex', request: upload });

  assert.equal(downloaded.action.status, 'completed');
  assert.equal(uploaded.action.status, 'pending_approval');
  assert.deepEqual(execution.transfers, [download]);
});

test('拒绝待审批动作后不能再次执行', async () => {
  const execution = new FakeExecutionPort();
  const coordinator = new CodrivingCoordinator(execution);
  const submission = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'uname -a'
  });

  const rejected = coordinator.rejectAction({
    actionId: submission.action.id,
    digest: submission.action.digest
  });

  assert.equal(rejected.status, 'rejected');
  await assert.rejects(
    coordinator.approveAction({ actionId: submission.action.id, digest: submission.action.digest }),
    /审批已失效/
  );
  assert.deepEqual(execution.commands, []);
});

test('客户端离线期间审批过期后自动拒绝执行', async () => {
  const execution = new FakeExecutionPort();
  let now = new Date('2026-07-24T00:00:00.000Z');
  const coordinator = new CodrivingCoordinator(execution, {
    now: () => now,
    approvalTtlMs: 60_000
  });
  const submission = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'rm -rf /'
  });
  now = new Date('2026-07-24T00:01:01.000Z');

  await assert.rejects(
    coordinator.approveAction({ actionId: submission.action.id, digest: submission.action.digest }),
    /审批已过期/
  );
  assert.equal(coordinator.listEvents(execution.session.id)[0]?.status, 'expired');
  assert.deepEqual(execution.commands, []);
});

test('高危动作等待审批时冻结同一会话后续 Codex 队列', async () => {
  const execution = new FakeExecutionPort();
  const coordinator = new CodrivingCoordinator(execution);
  coordinator.setAuthorizationLevel({
    sessionId: execution.session.id,
    authorizationLevel: 'trusted_session',
    trustedUntil: '2099-01-01T00:00:00.000Z'
  });

  const highRisk = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'rm -rf /'
  });
  const following = await coordinator.requestCommand({
    sessionId: execution.session.id,
    actor: 'codex',
    command: 'df -h'
  });

  assert.equal(highRisk.action.status, 'pending_approval');
  assert.equal(following.action.status, 'paused');
  assert.match(following.action.reason, /待审批/);
  assert.deepEqual(execution.commands, []);
});

test('审批摘要绑定完整命令，即使展示内容脱敏后相同也不能复用', async () => {
  const firstExecution = new FakeExecutionPort();
  const secondExecution = new FakeExecutionPort();
  const options = {
    id: () => 'same-action-id',
    now: () => new Date('2026-07-24T00:00:00.000Z')
  };
  const first = await new CodrivingCoordinator(firstExecution, options).requestCommand({
    sessionId: firstExecution.session.id,
    actor: 'codex',
    command: "curl -H 'Authorization: Bearer token-one' https://example.test"
  });
  const second = await new CodrivingCoordinator(secondExecution, options).requestCommand({
    sessionId: secondExecution.session.id,
    actor: 'codex',
    command: "curl -H 'Authorization: Bearer token-two' https://example.test"
  });

  assert.equal(first.action.summary, second.action.summary);
  assert.notEqual(first.action.digest, second.action.digest);
});

test('自动执行失败时共驾事件不会一直停留在进行中', async () => {
  const execution = new FakeExecutionPort();
  execution.session.authorizationLevel = 'auto_readonly';
  execution.commandError = new Error('remote failed');
  const coordinator = new CodrivingCoordinator(execution);

  await assert.rejects(
    coordinator.requestCommand({
      sessionId: execution.session.id,
      actor: 'codex',
      command: 'df -h'
    }),
    /remote failed/
  );

  assert.equal(coordinator.listEvents(execution.session.id)[0]?.status, 'failed');
});

test('共驾事件使用单调序号支持客户端按游标补回', async () => {
  const execution = new FakeExecutionPort();
  const coordinator = new CodrivingCoordinator(execution);

  await coordinator.requestCommand({ sessionId: execution.session.id, actor: 'user', command: 'pwd' });
  await coordinator.requestCommand({ sessionId: execution.session.id, actor: 'user', command: 'df -h' });

  assert.deepEqual(coordinator.listEvents(execution.session.id).map((event) => event.sequence), [1, 2]);
});
