import assert from 'node:assert/strict';
import test from 'node:test';
import { getMessageAutoDismissMs } from '../src/renderer/src/lib/message-lifecycle';

test('成功提示会自动消失，普通错误保留更久', () => {
  assert.equal(getMessageAutoDismissMs('success'), 4_000);
  assert.equal(getMessageAutoDismissMs('error'), 8_000);
});

test('需要用户继续处理的阻塞提示保持显示', () => {
  assert.equal(getMessageAutoDismissMs('blocking'), undefined);
  assert.equal(getMessageAutoDismissMs(undefined), undefined);
});
