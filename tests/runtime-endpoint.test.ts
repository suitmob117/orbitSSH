import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRuntimeEndpoint } from '../src/runtime/runtime-endpoint';

test('显式 Runtime 端点覆盖默认用户端点，供隔离测试和多实例使用', () => {
  const previous = process.env.ORBITSSH_RUNTIME_ENDPOINT;
  process.env.ORBITSSH_RUNTIME_ENDPOINT = '\\\\.\\pipe\\orbitssh-runtime-test';
  try {
    assert.equal(resolveRuntimeEndpoint(), '\\\\.\\pipe\\orbitssh-runtime-test');
  } finally {
    if (previous === undefined) delete process.env.ORBITSSH_RUNTIME_ENDPOINT;
    else process.env.ORBITSSH_RUNTIME_ENDPOINT = previous;
  }
});
