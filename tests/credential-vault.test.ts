import assert from 'node:assert/strict';
import test from 'node:test';

import { CredentialVault } from '../src/core/credential-vault';

test('删除不存在的凭据依赖 deleteCredential 的 false 返回值，不抛异常', async () => {
  let calls = 0;
  const vault = new CredentialVault(() => ({
    setPassword: async () => undefined,
    getPassword: async () => null,
    deleteCredential: async () => {
      calls += 1;
      return false;
    }
  }));

  await vault.deleteSecret('missing');
  assert.equal(calls, 1);
});

test('删除凭据的真实系统异常会传播', async () => {
  const vault = new CredentialVault(() => ({
    setPassword: async () => undefined,
    getPassword: async () => null,
    deleteCredential: async () => {
      throw new Error('credential manager unavailable');
    }
  }));

  await assert.rejects(vault.deleteSecret('existing'), /credential manager unavailable/);
});
