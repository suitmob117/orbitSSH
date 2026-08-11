import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodrivingAction } from '../src/shared/types';
import { prioritizeCodrivingActions, takeRecentChronological } from '../src/renderer/src/lib/activity';

function action(sequence: number, status: CodrivingAction['status']): CodrivingAction {
  return {
    id: `action-${sequence}`,
    sequence,
    digest: `digest-${sequence}`,
    sessionId: 'session-1',
    actor: 'codex',
    kind: 'command',
    status,
    risk: 'write',
    summary: `command-${sequence}`,
    reason: 'test',
    createdAt: `2026-08-10T00:00:0${sequence}.000Z`,
    updatedAt: `2026-08-10T00:00:0${sequence}.000Z`
  };
}

test('轨迹记录按时间正序显示，最新项位于底部', () => {
  assert.deepEqual(takeRecentChronological([1, 2, 3, 4], 3), [2, 3, 4]);
});

test('pending approvals stay at the top and are not dropped by the recent-item limit', () => {
  const sorted = prioritizeCodrivingActions([
    action(1, 'pending_approval'),
    action(2, 'completed'),
    action(3, 'completed'),
    action(4, 'completed'),
    action(5, 'completed'),
    action(6, 'completed'),
    action(7, 'completed'),
    action(8, 'running')
  ], 6);

  assert.deepEqual(sorted.map((item) => item.sequence), [1, 8, 4, 5, 6, 7]);
  assert.equal(sorted[0]?.status, 'pending_approval');
});
import type { CommandRecord } from '../src/shared/types';
import { getCommandActivityState } from '../src/renderer/src/lib/activity';

function record(overrides: Partial<CommandRecord> = {}): CommandRecord {
  return {
    id: 'record-1',
    sessionId: 'session-1',
    command: 'uptime',
    startedAt: '2026-07-23T00:00:00.000Z',
    stdoutTail: '',
    stderrTail: '',
    summary: 'Risk: readonly; exit code: 0; stdout 1 lines; stderr 0 lines.',
    ...overrides
  };
}

test('协作轨迹区分一般、高危以及进行中、历史操作', () => {
  assert.deepEqual(getCommandActivityState(record()), { risk: 'normal', phase: 'live' });
  assert.deepEqual(
    getCommandActivityState(record({
      finishedAt: '2026-07-23T00:00:01.000Z',
      summary: 'Risk: high; exit code: 0; stdout 0 lines; stderr 0 lines.'
    })),
    { risk: 'high', phase: 'history' }
  );
});

test('旧记录或未知摘要安全降级为一般操作', () => {
  assert.equal(getCommandActivityState(record({ summary: '旧版本摘要' })).risk, 'normal');
});
