import assert from 'node:assert/strict';
import test from 'node:test';

import { assessCommand } from '../src/core/command-policy';

test('识别单条明确的只读命令', () => {
  assert.equal(assessCommand('ls -la').risk, 'readonly');
});
