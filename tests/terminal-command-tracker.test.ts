import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTerminalEcho, TerminalCommandTracker } from '../src/renderer/src/lib/terminal-command-tracker';

test('本地终端回显正确处理普通文字、退格和回车', () => {
  assert.equal(formatTerminalEcho('pwd'), 'pwd');
  assert.equal(formatTerminalEcho('\x7f'), '\b \b');
  assert.equal(formatTerminalEcho('\r'), '\r\n');
  assert.equal(formatTerminalEcho('\x03'), '');
  assert.equal(formatTerminalEcho('\t\x1b[A'), '');
});

test('普通终端输入先在本地回显，回车时再生成完整的排队命令', () => {
  const tracker = new TerminalCommandTracker();

  assert.deepEqual(tracker.consume('pwd'), [{ type: 'echo', data: 'pwd' }]);
  assert.deepEqual(tracker.consume('\r'), [{ type: 'submit', command: 'pwd' }]);
  assert.deepEqual(tracker.consume('cd /opt\rwhoami\r'), [
    { type: 'echo', data: 'cd /opt' },
    { type: 'submit', command: 'cd /opt' },
    { type: 'echo', data: 'whoami' },
    { type: 'submit', command: 'whoami' }
  ]);
});

test('终端命令跟踪支持退格和取消，不把控制序列写进记录', () => {
  const tracker = new TerminalCommandTracker();

  tracker.consume('pwdd');
  tracker.consume('\x7f');
  assert.deepEqual(tracker.consume('\r'), [{ type: 'submit', command: 'pwd' }]);

  tracker.consume('secret');
  assert.deepEqual(tracker.consume('\x03'), [{ type: 'interrupt' }]);
  assert.deepEqual(tracker.consume('\r'), [{ type: 'echo', data: '\r' }]);
});

test('Tab 补全和方向键等复杂编辑不生成可能错误的命令记录', () => {
  const tracker = new TerminalCommandTracker();

  tracker.consume('cd /o');
  tracker.consume('\t');
  assert.deepEqual(tracker.consume('\r'), [{ type: 'unsupported' }]);

  tracker.consume('\x1b[A');
  assert.deepEqual(tracker.consume('\r'), [{ type: 'unsupported' }]);
});
