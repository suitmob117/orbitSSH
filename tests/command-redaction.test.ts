import assert from 'node:assert/strict';
import test from 'node:test';

import { redactCommand } from '../src/core/command-redaction';

const SENSITIVE_COMMAND = '[REDACTED:SENSITIVE_COMMAND]';

test('fails closed for a Cookie header parsed from a shell command', () => {
  assert.equal(redactCommand('curl -HCookie:sid=secret /'), SENSITIVE_COMMAND);
});

test('fails closed for split, long, assigned, quoted, and nested Cookie headers', () => {
  const commands = [
    'curl -H Cookie:sid=secret /',
    'curl --header Cookie:sid=secret /',
    'curl --header=Cookie:sid=secret /',
    'curl -H "Cookie: sid=secret" /',
    "curl -H 'Cookie: sid=secret' /",
    'echo $(curl -H Cookie:sid=secret)',
    'printf Cookie:sid=secret'
  ];

  for (const command of commands) {
    assert.equal(redactCommand(command), SENSITIVE_COMMAND, command);
  }
});

test('fails closed for equivalent Authorization Bearer header forms', () => {
  const commands = [
    'curl -HAuthorization:Bearer\\ secret /',
    'curl -H Authorization:Bearer\\ secret /',
    'curl --header Authorization:Bearer\\ secret /',
    'curl --header=Authorization:Bearer\\ secret /',
    'curl -H "Authorization: Bearer secret" /',
    "curl -H 'Authorization: Bearer secret' /",
    'echo $(curl -H Authorization:Bearer\\ secret)',
    'printf Authorization:Bearer\\ secret'
  ];

  for (const command of commands) {
    assert.equal(redactCommand(command), SENSITIVE_COMMAND, command);
  }
});

test('fails closed for sensitive headers containing shell glob patterns', () => {
  const commands = [
    'curl -HCookie:sid=* /',
    'curl -H Cookie:sid=* /',
    'curl --header=Authorization:Bearer* /',
    'printf Cookie:sid=?'
  ];

  for (const command of commands) {
    assert.equal(redactCommand(command), SENSITIVE_COMMAND, command);
  }
});

test('uses an HTTP header-token left boundary without matching header-name lookalikes', () => {
  assert.equal(redactCommand("printf '[Cookie: sid=secret]'"), SENSITIVE_COMMAND);
  assert.equal(
    redactCommand('echo XAuthorization:Bearer\\ public'),
    'echo XAuthorization:Bearer\\ public'
  );
  assert.equal(redactCommand('echo mycookie:sid=public'), 'echo mycookie:sid=public');
});

test('fails closed on parse errors only when the raw command has a standard sensitive header', () => {
  assert.equal(redactCommand('echo ${Cookie: sid=secret'), SENSITIVE_COMMAND);
  assert.equal(redactCommand('echo ${foo password=hunter2'), 'echo ${foo password=[REDACTED]');
});

test('uses the existing redaction rules for commands without sensitive headers', () => {
  assert.equal(redactCommand('echo password=hunter2'), 'echo password=[REDACTED]');
  assert.equal(
    redactCommand('psql postgresql://alice:hunter2@db/app'),
    'psql postgresql://alice:[REDACTED]@db/app'
  );
});
