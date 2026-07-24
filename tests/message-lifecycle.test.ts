import assert from 'node:assert/strict';
import test from 'node:test';
import { getMessageAutoDismissMs } from '../src/renderer/src/lib/message-lifecycle';

test('连接成功是短暂提示，连接失败继续保留供用户查看', () => {
  assert.equal(getMessageAutoDismissMs('连接成功'), 2_500);
  assert.equal(getMessageAutoDismissMs('连接失败：认证失败'), undefined);
  assert.equal(getMessageAutoDismissMs(undefined), undefined);
});
