import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = process.cwd();
const nodeBinding = path.join(projectRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const electronRebuild = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild'
);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const nodeHashBefore = hash(nodeBinding);

const result = spawnSync(electronRebuild, [
  '--force',
  '--which-module', 'better-sqlite3-electron',
  '--only', 'better-sqlite3-electron'
], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.error) throw result.error;
assert.equal(result.status, 0, `Electron SQLite 重建失败，退出码：${result.status}`);
assert.equal(hash(nodeBinding), nodeHashBefore, 'Electron SQLite 重建覆盖了 Node ABI 二进制');
console.log('Electron SQLite 重建完成，Node ABI 二进制保持不变。');
