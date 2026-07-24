import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileBoundary } from '../src/core/file-boundary';

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-ssh-file-boundary-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('仅允许上传允许本地目录内的真实文件，并规范化远程路径', async () => {
  await withTempDirectory(async (directory) => {
    const localRoot = path.join(directory, 'allowed');
    const source = path.join(localRoot, 'nested', 'report.txt');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'report');
    const boundary = new FileBoundary({ localRoot, remoteRoots: ['/srv/app'] });

    const transfer = await boundary.resolve({ direction: 'upload', localPath: source, remotePath: '/srv/app/nested/./report.txt' });

    assert.equal(transfer.localPath, source);
    assert.equal(transfer.remotePath, '/srv/app/nested/report.txt');
  });
});

test('拒绝本地 .. 逃逸、符号链接逃逸和远程目录逃逸', async (t) => {
  await withTempDirectory(async (directory) => {
    const localRoot = path.join(directory, 'allowed');
    const outsideRoot = path.join(directory, 'outside');
    const inside = path.join(localRoot, 'inside.txt');
    const outside = path.join(outsideRoot, 'secret.txt');
    await mkdir(localRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(inside, 'inside');
    await writeFile(outside, 'secret');
    const boundary = new FileBoundary({ localRoot, remoteRoots: ['/srv/app'] });

    await assert.rejects(
      boundary.resolve({ direction: 'upload', localPath: path.join(localRoot, '..', 'outside', 'secret.txt'), remotePath: '/srv/app/secret.txt' }),
      /允许目录/
    );
    await assert.rejects(
      boundary.resolve({ direction: 'upload', localPath: inside, remotePath: '/srv/app/../secret.txt' }),
      /允许目录/
    );
    await assert.rejects(
      boundary.resolve({ direction: 'upload', localPath: inside, remotePath: '/srv/application/report.txt' }),
      /允许目录/
    );

    const escapeLink = path.join(localRoot, 'escape-link');
    try {
      await symlink(outsideRoot, escapeLink, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('当前 Windows 环境不允许创建目录符号链接');
        return;
      }
      throw error;
    }
    await assert.rejects(
      boundary.resolve({ direction: 'upload', localPath: path.join(escapeLink, 'secret.txt'), remotePath: '/srv/app/secret.txt' }),
      /允许目录/
    );
  });
});

test('下载只写入允许目录内真实存在的父目录', async () => {
  await withTempDirectory(async (directory) => {
    const localRoot = path.join(directory, 'downloads');
    const nested = path.join(localRoot, 'nested');
    const outside = path.join(directory, 'outside');
    await mkdir(nested, { recursive: true });
    await mkdir(outside, { recursive: true });
    const boundary = new FileBoundary({ localRoot, remoteRoots: ['/srv/app'] });

    const transfer = await boundary.resolve({
      direction: 'download',
      localPath: path.join(nested, 'report.txt'),
      remotePath: '/srv/app/report.txt'
    });
    assert.equal(transfer.remotePath, '/srv/app/report.txt');

    await assert.rejects(
      boundary.resolve({
        direction: 'download',
        localPath: path.join(outside, 'report.txt'),
        remotePath: '/srv/app/report.txt'
      }),
      /允许目录/
    );
  });
});

test('下载拒绝指向允许目录外的既有符号链接目标', async (t) => {
  await withTempDirectory(async (directory) => {
    const localRoot = path.join(directory, 'downloads');
    const outside = path.join(directory, 'outside');
    const outsideFile = path.join(outside, 'secret.txt');
    await mkdir(localRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(outsideFile, 'secret');
    const targetLink = path.join(localRoot, 'report.txt');
    try {
      await symlink(outsideFile, targetLink, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('当前 Windows 环境不允许创建文件符号链接');
        return;
      }
      throw error;
    }
    const boundary = new FileBoundary({ localRoot, remoteRoots: ['/srv/app'] });

    await assert.rejects(
      boundary.resolve({ direction: 'download', localPath: targetLink, remotePath: '/srv/app/report.txt' }),
      /允许目录/
    );
  });
});

test('未配置允许目录时拒绝所有文件传输', async () => {
  const boundary = new FileBoundary({ remoteRoots: [] });
  await assert.rejects(
    boundary.resolve({ direction: 'upload', localPath: 'C:\\report.txt', remotePath: '/srv/app/report.txt' }),
    /未配置.*允许目录/
  );
});

test('远程目录浏览复用文件传输边界并规范化路径', () => {
  const boundary = new FileBoundary({ localRoot: 'C:\\Downloads', remoteRoots: ['/srv/app'] });

  assert.equal(boundary.resolveRemotePath('/srv/app/logs/.'), '/srv/app/logs');
  assert.throws(() => boundary.resolveRemotePath('/srv/application'), /允许目录/);
  assert.throws(() => boundary.resolveRemotePath('/srv/app/../secret'), /允许目录/);
  assert.equal(boundary.resolveRemoteBrowsePath('/etc/ssh/.'), '/etc/ssh');
  assert.throws(() => boundary.resolveRemoteBrowsePath('/etc/../root'), /浏览路径/);
});
