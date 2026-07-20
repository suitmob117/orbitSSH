import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessCommand,
  authorizeCommand,
  authorizeTransfer,
  enforceCommandAuthorization,
  enforceTransferAuthorization
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
  assert.equal(assessCommand('ls & python mutate.py').risk, 'write');
});

test('ambiguous readonly-looking commands require approval', () => {
  const commands = [
    'find . -delete',
    'find . -exec /tmp/mutate {} +',
    'date --set=tomorrow',
    'journalctl --rotate',
    'rg --pre mutate pattern',
    'less -o output.log file'
  ];

  for (const command of commands) {
    assert.equal(assessCommand(command).risk, 'write');
    assert.equal(authorizeCommand('auto_readonly', command).allowed, false);
  }
});

test('high risk commands retain their risk in compound syntax', () => {
  assert.equal(assessCommand('rm -rf /; true').risk, 'high');
  assert.equal(assessCommand('shutdown -h now && true').risk, 'high');
  assert.equal(assessCommand('sudo -n rm -rf /tmp/demo').risk, 'high');
  assert.equal(assessCommand('rm -fr /').risk, 'high');
  assert.equal(assessCommand('rm -r -f /').risk, 'high');
  assert.equal(assessCommand('rm --recursive --force /').risk, 'high');
  assert.equal(assessCommand('sudo -- rm -rf /').risk, 'high');
  assert.equal(assessCommand('sudo -u root -- rm -rf /').risk, 'high');
  assert.equal(assessCommand('FOO=bar rm -rf /').risk, 'high');
  assert.equal(assessCommand('sudo FOO=bar rm -rf /').risk, 'high');
  assert.equal(assessCommand('command rm -rf /').risk, 'high');
  assert.equal(assessCommand('env rm -rf /').risk, 'high');
  assert.equal(assessCommand('sudo -D /tmp rm -rf /').risk, 'high');
  assert.equal(assessCommand('command shutdown -h now').risk, 'high');
  assert.equal(assessCommand('FOO=bar shutdown -h now').risk, 'high');
  assert.equal(assessCommand('sudo env reboot').risk, 'high');
  assert.equal(assessCommand("bash -c 'rm -rf /'").risk, 'high');
});

test('empty commands are treated as write operations', () => {
  assert.equal(assessCommand('   ').risk, 'write');
});

test('auto readonly sessions allow only explicit readonly commands', () => {
  assert.equal(authorizeCommand('auto_readonly', 'df -h').allowed, true);
  assert.equal(authorizeCommand('auto_readonly', 'mkdir /tmp/demo').allowed, false);
  assert.equal(authorizeCommand('auto_readonly', 'ls && python mutate.py').allowed, false);
  assert.equal(authorizeCommand('auto_readonly', 'ls & python mutate.py').allowed, false);
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

test('auto readonly sessions enforce command authorization', () => {
  assert.throws(
    () => enforceCommandAuthorization('auto_readonly', 'mkdir /tmp/demo'),
    /当前会话为“只读自动”/
  );
  assert.doesNotThrow(() => enforceCommandAuthorization('auto_readonly', 'df -h'));
});

test('auto readonly sessions enforce transfer authorization', () => {
  assert.throws(
    () => enforceTransferAuthorization('auto_readonly', 'upload'),
    /已拒绝文件上传/
  );
  assert.doesNotThrow(() => enforceTransferAuthorization('auto_readonly', 'download'));
});
