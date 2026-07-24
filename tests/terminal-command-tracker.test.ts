import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalCommandTracker } from '../src/renderer/src/lib/terminal-command-tracker';

test('普通终端输入在回车时生成可记录命令，同时保留原始按键写入顺序', () => {
  const tracker = new TerminalCommandTracker();

  assert.deepEqual(tracker.consume('pwd'), [{ type: 'write', data: 'pwd' }]);
  assert.deepEqual(tracker.consume('\r'), [{ type: 'submit', command: 'pwd' }]);
  assert.deepEqual(tracker.consume('cd /opt\rwhoami\r'), [
    { type: 'write', data: 'cd /opt' },
    { type: 'submit', command: 'cd /opt' },
    { type: 'write', data: 'whoami' },
    { type: 'submit', command: 'whoami' }
  ]);
});

test('终端命令跟踪支持退格和取消，不把控制序列写进记录', () => {
  const tracker = new TerminalCommandTracker();

  tracker.consume('pwdd');
  tracker.consume('\x7f');
  assert.deepEqual(tracker.consume('\r'), [{ type: 'submit', command: 'pwd' }]);

  tracker.consume('secret');
  assert.deepEqual(tracker.consume('\x03'), [{ type: 'write', data: '\x03' }]);
  assert.deepEqual(tracker.consume('\r'), [{ type: 'write', data: '\r' }]);
});

test('Tab 补全和方向键等复杂编辑不生成可能错误的命令记录', () => {
  const tracker = new TerminalCommandTracker();

  tracker.consume('cd /o');
  tracker.consume('\t');
  assert.deepEqual(tracker.consume('\r'), [{ type: 'write', data: '\r' }]);

  tracker.consume('\x1b[A');
  assert.deepEqual(tracker.consume('\r'), [{ type: 'write', data: '\r' }]);
});
