import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CodrivingCoordinator } from '../src/core/codriving-coordinator';
import { RuntimeController } from '../src/runtime/runtime-controller';
import type { ConnectionSession } from '../src/shared/types';

function createHarness(notifier?: { notifyPendingApproval(): void }) {
  const terminalWrites: string[] = [];
  const session: ConnectionSession = {
    id: 'session-1',
    profileId: 'profile-1',
    profileName: '测试服务器',
    health: 'connected',
    authorizationLevel: 'ask_every_time',
    openedAt: new Date().toISOString()
  };
  const sessionManager = Object.assign(new EventEmitter(), {
    listSessions: () => [session],
    openSession: async (_profileId: string, authorizationLevel?: ConnectionSession['authorizationLevel']) => {
      if (authorizationLevel) session.authorizationLevel = authorizationLevel;
      return session;
    },
    closeSession: async () => undefined,
    getSession: () => session,
    setAuthorizationLevel: (_sessionId: string, level: ConnectionSession['authorizationLevel']) => {
      session.authorizationLevel = level;
      return session;
    },
    executeCommand: async () => ({
      record: {
        id: 'record-1', sessionId: session.id, command: 'pwd', startedAt: '',
        stdoutTail: '/srv', stderrTail: '', summary: 'ok'
      },
      stdout: '/srv',
      stderr: ''
    }),
    getTerminalSessionId: () => session.id,
    writeTerminal: (_terminalId: string, data: string) => terminalWrites.push(data)
  });
  const coordinator = new CodrivingCoordinator(sessionManager as never);
  const controller = new RuntimeController({
    services: {
      profileStore: { list: async () => [] },
      historyStore: { list: async () => [] },
      credentialVault: {},
      sessionManager,
      close: () => undefined
    } as never,
    coordinator,
    notifier
  });
  return { controller, session, terminalWrites };
}

test('没有桌面客户端时，待审批动作只触发不含操作详情的系统通知', async () => {
  let notifications = 0;
  const { controller } = createHarness({
    notifyPendingApproval: () => { notifications += 1; }
  });

  await controller.handle(
    'commands:request',
    { sessionId: 'session-1', command: 'pwd' },
    { clientId: 'mcp-1', kind: 'mcp' }
  );

  assert.equal(notifications, 1);

  let attachedNotifications = 0;
  const attached = createHarness({
    notifyPendingApproval: () => { attachedNotifications += 1; }
  });
  attached.controller.clientConnected({ clientId: 'desktop-1', kind: 'desktop' });
  await attached.controller.handle(
    'commands:request',
    { sessionId: 'session-1', command: 'pwd' },
    { clientId: 'mcp-1', kind: 'mcp' }
  );
  assert.equal(attachedNotifications, 0);
  attached.controller.clientDisconnected({ clientId: 'desktop-1', kind: 'desktop' });
  assert.equal(attachedNotifications, 1);
});

test('立即关闭全部能力时明确拒绝尚未处理的审批动作', async () => {
  const { controller } = createHarness();
  const pending = await controller.handle(
    'commands:request',
    { sessionId: 'session-1', command: 'pwd' },
    { clientId: 'mcp-1', kind: 'mcp' }
  ) as { action: { sequence: number } };

  await controller.handle(
    'runtime:set-exit-policy',
    { policy: 'close_all' },
    { clientId: 'desktop-1', kind: 'desktop' }
  );
  const updates = await controller.handle(
    'codriving:events',
    { sessionId: 'session-1', afterSequence: pending.action.sequence },
    { clientId: 'desktop-1', kind: 'desktop' }
  ) as Array<{ status: string }>;

  assert.equal(updates.at(-1)?.status, 'rejected');
});

test('MCP 只能复用会话，不能自行提升 Codex 授权等级', async () => {
  const { controller, session } = createHarness();

  const opened = await controller.handle(
    'sessions:open',
    { profileId: 'profile-1', authorizationLevel: 'trusted_session' },
    { clientId: 'mcp-1', kind: 'mcp' }
  );

  assert.equal((opened as ConnectionSession).id, session.id);
  assert.equal(session.authorizationLevel, 'ask_every_time');
});

test('用户操作终端不会自动断开 Codex，后续动作仍按授权规则处理', async () => {
  const { controller, terminalWrites } = createHarness();

  await controller.handle(
    'terminal:write',
    { sessionId: 'session-1', terminalId: 'terminal-1', data: 'l' },
    { clientId: 'desktop-1', kind: 'desktop' }
  );
  const submission = await controller.handle(
    'commands:request',
    { sessionId: 'session-1', command: 'pwd' },
    { clientId: 'mcp-1', kind: 'mcp' }
  );

  assert.deepEqual(terminalWrites, ['l']);
  assert.equal((submission as { action: { status: string } }).action.status, 'pending_approval');
  assert.equal(await controller.handle(
    'codriving:paused',
    { sessionId: 'session-1' },
    { clientId: 'desktop-1', kind: 'desktop' }
  ), false);
});

test('桌面终端命令通过共驾协调器提交，MCP 不能冒充用户终端', async () => {
  const { controller } = createHarness();

  const submission = await controller.handle(
    'terminal:submit',
    { sessionId: 'session-1', terminalId: 'terminal-1', command: 'pwd' },
    { clientId: 'desktop-1', kind: 'desktop' }
  );
  assert.equal((submission as { action: { actor: string; status: string } }).action.actor, 'user');
  assert.equal((submission as { action: { status: string } }).action.status, 'completed');
  assert.equal((submission as { result: { record: { command: string } } }).result.record.command, 'pwd');

  await assert.rejects(
    controller.handle(
      'terminal:submit',
      { sessionId: 'session-1', terminalId: 'terminal-1', command: 'pwd' },
      { clientId: 'mcp-1', kind: 'mcp' }
    ),
    /MCP.*terminal:submit/
  );
});

test('MCP 提交的命令始终按 Codex 身份处理，且不能调用批准接口', async () => {
  const { controller } = createHarness();

  const submission = await controller.handle(
    'commands:request',
    { sessionId: 'session-1', command: 'pwd', actor: 'user' },
    { clientId: 'mcp-1', kind: 'mcp' }
  );

  assert.equal((submission as { action: { actor: string; status: string } }).action.actor, 'codex');
  assert.equal((submission as { action: { status: string } }).action.status, 'pending_approval');
  await assert.rejects(
    controller.handle(
      'codriving:approve',
      { actionId: 'action-1', digest: 'digest' },
      { clientId: 'mcp-1', kind: 'mcp' }
    ),
    /MCP 客户端无权调用/
  );
  await assert.rejects(
    controller.handle(
      'sessions:close',
      { sessionId: 'session-1' },
      { clientId: 'mcp-1', kind: 'mcp' }
    ),
    /MCP 客户端无权调用/
  );
});
