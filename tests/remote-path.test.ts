import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatFileSize,
  getRemoteParent,
  isRemotePathWithinRoots,
  joinRemotePath,
  normalizeRemotePath
} from '../src/renderer/src/lib/remote-path';

test('远程目录路径使用 POSIX 规则连接并规范化', () => {
  assert.equal(joinRemotePath('/srv/app/', 'release.zip'), '/srv/app/release.zip');
  assert.equal(joinRemotePath('/', 'release.zip'), '/release.zip');
  assert.equal(normalizeRemotePath('/srv//app/'), '/srv/app');
});

test('返回上级目录时不会越过当前允许根目录', () => {
  assert.equal(getRemoteParent('/srv/app/releases/2026', '/srv/app'), '/srv/app/releases');
  assert.equal(getRemoteParent('/srv/app', '/srv/app'), '/srv/app');
  assert.equal(getRemoteParent('/other/place', '/srv/app'), '/srv/app');
  assert.equal(getRemoteParent('/var/log', '/'), '/var');
});

test('浏览可到服务器根目录，但传输范围仍按允许目录判断', () => {
  assert.equal(getRemoteParent('/opt', '/'), '/');
  assert.equal(isRemotePathWithinRoots('/opt/releases', ['/opt']), true);
  assert.equal(isRemotePathWithinRoots('/etc', ['/opt', '/srv/app']), false);
  assert.equal(isRemotePathWithinRoots('/srv/application', ['/srv/app']), false);
});

test('文件大小使用易读单位展示', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1024 * 1024), '1 MB');
});
