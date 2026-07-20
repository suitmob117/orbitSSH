import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessCommand,
  authorizeCommand,
  authorizeTransfer
} from '../src/core/command-policy';

test('识别单条明确的只读命令', () => {
  assert.equal(assessCommand('ls -la').risk, 'readonly');
});

test('complex commands cannot masquerade as readonly commands', () => {
  assert.equal(assessCommand('ls; python mutate.py').risk, 'write');
  assert.equal(assessCommand('ps aux | grep node').risk, 'write');
  assert.equal(assessCommand('cat $(echo /etc/passwd)').risk, 'write');
  assert.equal(assessCommand('cat file > copy').risk, 'write');
  assert.equal(assessCommand('pwd\nuname -a').risk, 'write');
});

test('empty commands are treated as write operations', () => {
  assert.equal(assessCommand('   ').risk, 'write');
});

test('auto readonly sessions allow only explicit readonly commands', () => {
  assert.equal(authorizeCommand('auto_readonly', 'df -h').allowed, true);
  assert.equal(authorizeCommand('auto_readonly', 'mkdir /tmp/demo').allowed, false);
  assert.equal(authorizeCommand('auto_readonly', 'ls && python mutate.py').allowed, false);
});

test('client-approved sessions allow write commands', () => {
  assert.equal(authorizeCommand('ask_every_time', 'mkdir /tmp/demo').allowed, true);
  assert.equal(authorizeCommand('trusted_session', 'mkdir /tmp/demo').allowed, true);
});

test('auto readonly sessions allow downloads but deny uploads', () => {
  assert.equal(authorizeTransfer('auto_readonly', 'download').allowed, true);
  assert.equal(authorizeTransfer('auto_readonly', 'upload').allowed, false);
  assert.equal(authorizeTransfer('ask_every_time', 'upload').allowed, true);
});
