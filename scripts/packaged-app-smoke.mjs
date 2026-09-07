import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const executable = path.resolve(
  process.env.ORBITSSH_PACKAGED_EXECUTABLE ?? 'release/win-unpacked/OrbitSSH.exe'
);
assert.equal(existsSync(executable), true, `找不到打包后的应用：${executable}`);

const dataDir = await mkdtemp(path.join(tmpdir(), 'orbitssh-packaged-smoke-'));
const endpoint = process.platform === 'win32'
  ? `\\\\.\\pipe\\orbitssh-packaged-smoke-${process.pid}`
  : path.join(dataDir, 'runtime.sock');

async function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }
  await new Promise((resolve) => {
    const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
    taskkill.once('error', resolve);
    taskkill.once('close', resolve);
  });
}

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd: path.dirname(executable),
      windowsHide: true,
      env: {
        ...process.env,
        AI_SSH_DATA_DIR: dataDir,
        ORBITSSH_RUNTIME_ENDPOINT: endpoint,
        ORBITSSH_PACKAGED_SMOKE_TEST: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timeout = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child);
      reject(new Error('打包应用启动验证超时'));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (code !== 0 && stderr) process.stderr.write(stderr);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0, `打包应用启动失败，退出码：${exitCode}`);
  console.log('OrbitSSH 打包应用启动、品牌图标、Runtime 和 SQLite 冒烟验证通过。');
} finally {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
