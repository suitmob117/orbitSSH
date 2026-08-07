import type { EventEmitter } from 'node:events';

export function registerElectronCleanup(_app: EventEmitter, _close: () => void): void {
  _app.once('before-quit', once(_close));
}

export function registerProcessCleanup(
  _close: () => void,
  _runtime: EventEmitter & { exit(code?: number): never } = process
): void {
  const cleanup = once(_close);
  _runtime.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    _runtime.once(signal, () => {
      cleanup();
      _runtime.exit(0);
    });
  }
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
