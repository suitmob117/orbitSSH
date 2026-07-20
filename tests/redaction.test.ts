import assert from 'node:assert/strict';
import test from 'node:test';

import { redact, tail } from '../src/core/redaction';

test('redacts password, token, and API key values', () => {
  const output = redact('password=hunter2 token:abc123 api_key=secret-value');

  assert.equal(output.includes('hunter2'), false);
  assert.equal(output.includes('abc123'), false);
  assert.equal(output.includes('secret-value'), false);
  assert.equal((output.match(/\[REDACTED\]/g) ?? []).length, 3);
});

test('redacts an entire private key block', () => {
  const privateKey = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----';

  assert.equal(redact(privateKey), '[REDACTED]');
});

test('tail redacts sensitive values before truncating output', () => {
  const output = tail('prefix password=hidden-value suffix', 24);

  assert.equal(output.includes('hidden-value'), false);
});
