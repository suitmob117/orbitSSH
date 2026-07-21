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

test('redacts quoted password and token values while preserving their quotes', () => {
  assert.equal(redact('password="hunter2"'), 'password="[REDACTED]"');
  assert.equal(redact("token='abc123'"), "token='[REDACTED]'");
});

test('redacts JSON password and API key values while preserving JSON structure', () => {
  assert.equal(
    redact('{"password":"hunter2","api_key":"abc123"}'),
    '{"password":"[REDACTED]","api_key":"[REDACTED]"}'
  );
});

test('redacts common JSON authentication secrets while preserving JSON structure', () => {
  assert.equal(
    redact('{"access_token":"abc","refresh_token":"def","client_secret":"ghi"}'),
    '{"access_token":"[REDACTED]","refresh_token":"[REDACTED]","client_secret":"[REDACTED]"}'
  );
});

test('redacts JSON Authorization and Cookie values while preserving JSON structure', () => {
  assert.equal(
    redact('{"Authorization":"Bearer json-secret","Cookie":"sid=cookie-secret"}'),
    '{"Authorization":"[REDACTED]","Cookie":"[REDACTED]"}'
  );
});

test('redacts a non-Bearer JSON Authorization value and keeps Cookie redacted', () => {
  assert.equal(
    redact('{"Authorization":"Basic basic-secret","Cookie":"sid=cookie-secret"}'),
    '{"Authorization":"[REDACTED]","Cookie":"[REDACTED]"}'
  );
});

test('redacts a Bearer token while preserving the Authorization header', () => {
  assert.equal(
    redact('Authorization: Bearer abc.def-123'),
    'Authorization: Bearer [REDACTED]'
  );
});

test('redacts an embedded Bearer token while preserving the command structure', () => {
  assert.equal(
    redact('curl -H "Authorization: Bearer abc.def-123" /'),
    'curl -H "Authorization: Bearer [REDACTED]" /'
  );
});

test('redacts the entire Cookie header value', () => {
  assert.equal(redact('Cookie: session=abc; csrf=def'), 'Cookie: [REDACTED]');
});

test('redacts an embedded Cookie value while preserving the log prefix', () => {
  assert.equal(
    redact('request failed: Cookie: session=abc'),
    'request failed: Cookie: [REDACTED]'
  );
});

test('redacts a password embedded in a PostgreSQL userinfo URI', () => {
  assert.equal(
    redact('postgresql://alice:hunter2@db/app'),
    'postgresql://alice:[REDACTED]@db/app'
  );
});

test('redacts quoted values containing basic escaped characters', () => {
  assert.equal(redact('password="hunter\\"2"'), 'password="[REDACTED]"');
});

test('redacts an entire private key block', () => {
  const privateKey = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----';

  assert.equal(redact(privateKey), '[REDACTED]');
});

test('tail redacts sensitive values before truncating output', () => {
  const output = tail('prefix password=hidden-value suffix', 24);

  assert.equal(output.includes('hidden-value'), false);
});
