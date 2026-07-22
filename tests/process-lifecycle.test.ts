import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { registerElectronCleanup, registerProcessCleanup } from '../src/core/process-lifecycle';

test('Electron before-quit 只关闭一次共享存储', () => {
  const app = new EventEmitter();
  let closeCalls = 0;
  registerElectronCleanup(app, () => {
    closeCalls += 1;
  });

  app.emit('before-quit');
  app.emit('before-quit');
  assert.equal(closeCalls, 1);
});

test('MCP 进程退出或收到信号时关闭一次共享存储，信号路径随后退出', () => {
  const runtime = new EventEmitter() as EventEmitter & { exit(code?: number): never };
  const exitCodes: number[] = [];
  runtime.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  });
  let closeCalls = 0;
  registerProcessCleanup(() => {
    closeCalls += 1;
  }, runtime);

  runtime.emit('SIGTERM');
  runtime.emit('exit', 0);
  runtime.emit('SIGINT');
  assert.equal(closeCalls, 1);
  assert.deepEqual(exitCodes, [0, 0]);
});
