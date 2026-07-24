import assert from 'node:assert/strict';
import test from 'node:test';
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
