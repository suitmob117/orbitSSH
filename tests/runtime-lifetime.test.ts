import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeLifetime } from '../src/runtime/runtime-lifetime';

test('关闭桌面端并选择 Codex 继续后，Runtime 保留共享会话', () => {
  const lifetime = new RuntimeLifetime();
  lifetime.attachClient({ id: 'desktop-1', kind: 'desktop' });
  lifetime.retainSession('session-1');
  lifetime.setDesktopExitPolicy('keep_codex');

  lifetime.detachClient('desktop-1');

  assert.equal(lifetime.snapshot().shouldShutdown, false);
  assert.deepEqual(lifetime.snapshot().retainedSessionIds, ['session-1']);
});

test('选择任务完成后退出时，最后一个动作结束后 Runtime 才关闭', () => {
  const lifetime = new RuntimeLifetime();
  lifetime.attachClient({ id: 'desktop-1', kind: 'desktop' });
  lifetime.attachClient({ id: 'mcp-1', kind: 'mcp' });
  lifetime.retainSession('session-1');
  lifetime.beginAction('action-1');
  lifetime.setDesktopExitPolicy('finish_then_exit');
  lifetime.detachClient('desktop-1');

  assert.equal(lifetime.snapshot().shouldShutdown, false);
  lifetime.finishAction('action-1');
  assert.equal(lifetime.snapshot().shouldShutdown, true);
  assert.deepEqual(lifetime.snapshot().sessionIdsToClose, ['session-1']);
});

test('选择立即关闭全部能力时，即使 MCP 仍连接也要求 Runtime 退出', () => {
  const lifetime = new RuntimeLifetime();
  lifetime.attachClient({ id: 'desktop-1', kind: 'desktop' });
  lifetime.attachClient({ id: 'mcp-1', kind: 'mcp' });
  lifetime.retainSession('session-1');
  lifetime.beginAction('action-1');
  lifetime.setDesktopExitPolicy('close_all');
  lifetime.detachClient('desktop-1');

  assert.equal(lifetime.snapshot().shouldShutdown, true);
  assert.deepEqual(lifetime.snapshot().sessionIdsToClose, ['session-1']);
});
