import assert from 'node:assert/strict';
import test from 'node:test';

import { profileInputSchema } from '../src/shared/validation';

const validProfileInput = {
  name: '测试服务器',
  host: '203.0.113.10',
  port: 22,
  username: 'root',
  authMethod: 'ssh_agent' as const,
  connectTimeoutMs: 15_000,
  keepaliveIntervalMs: 15_000
};

test('配置输入允许可选路径留空并统一归一化为未配置', () => {
  const parsed = profileInputSchema.parse({
    ...validProfileInput,
    privateKeyPath: '',
    jumpHost: '   ',
    localTransferRoot: '',
    remoteTransferRoots: ['', '  /srv/app  ', '   ']
  });

  assert.equal(parsed.privateKeyPath, undefined);
  assert.equal(parsed.jumpHost, undefined);
  assert.equal(parsed.localTransferRoot, undefined);
  assert.deepEqual(parsed.remoteTransferRoots, ['/srv/app']);
});
