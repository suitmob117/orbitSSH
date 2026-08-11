import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppExitFlow } from '../src/core/app-exit-flow';

test('取消退出确认后保留窗口，后续仍可再次发起退出', async () => {
  let preventDefaultCalls = 0;
  let promptCalls = 0;
  let quitCalls = 0;

  const flow = createAppExitFlow({
    hasRuntime: () => true,
    choosePolicy: async () => {
      promptCalls += 1;
      return false;
    },
    closeRuntime: async () => undefined,
    allowQuit: () => undefined,
    quit: () => {
      quitCalls += 1;
    },
    reportError: () => undefined
  });

  flow.onWindowClose({ preventDefault: () => { preventDefaultCalls += 1; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(preventDefaultCalls, 1);
  assert.equal(promptCalls, 1);
  assert.equal(quitCalls, 0);

  flow.onWindowClose({ preventDefault: () => { preventDefaultCalls += 1; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(preventDefaultCalls, 2);
  assert.equal(promptCalls, 2);
  assert.equal(quitCalls, 0);
});

test('确认退出后只允许一次真正的应用退出', async () => {
  let preventDefaultCalls = 0;
  let closeRuntimeCalls = 0;
  let allowQuitCalls = 0;
  let quitCalls = 0;

  const flow = createAppExitFlow({
    hasRuntime: () => true,
    choosePolicy: async () => true,
    closeRuntime: async () => {
      closeRuntimeCalls += 1;
    },
    allowQuit: () => {
      allowQuitCalls += 1;
    },
    quit: () => {
      quitCalls += 1;
    },
    reportError: () => undefined
  });

  flow.onWindowClose({ preventDefault: () => { preventDefaultCalls += 1; } });
  await new Promise((resolve) => setImmediate(resolve));

  flow.onBeforeQuit({ preventDefault: () => { preventDefaultCalls += 1; } });
  assert.equal(preventDefaultCalls, 1);
  assert.equal(closeRuntimeCalls, 1);
  assert.equal(allowQuitCalls, 1);
  assert.equal(quitCalls, 1);
});
