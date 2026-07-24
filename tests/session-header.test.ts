import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionProfile, ConnectionSession } from '../src/shared/types';
import { SessionHeader } from '../src/renderer/src/components/session-header';

const noop = (): void => undefined;

test('会话操作使用带中文提示的纯图标按钮', () => {
  const profile = {
    name: 'TencentCloud-2C8G',
    username: 'root',
    host: '42.193.112.79',
    port: 22
  } as ConnectionProfile;
  const session = {} as ConnectionSession;

  const html = renderToStaticMarkup(createElement(SessionHeader, {
    profile,
    session,
    authorizationLevel: 'ask_every_time',
    codexPaused: false,
    busy: false,
    onAuthorizationLevelChange: noop,
    onToggleCodexPause: noop,
    onHealthCheck: noop,
    onConnect: noop,
    onDisconnect: noop,
    onOpenTransfer: noop
  }));

  const codexSwitch = html.match(/<button[^>]*aria-label="完全接管：暂停 Codex"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(codexSwitch, '缺少 Codex 接入开关');
  assert.match(codexSwitch, /role="switch"/);
  assert.match(codexSwitch, /aria-checked="true"/);

  const pausedHtml = renderToStaticMarkup(createElement(SessionHeader, {
    profile,
    session,
    authorizationLevel: 'ask_every_time',
    codexPaused: true,
    busy: false,
    onAuthorizationLevelChange: noop,
    onToggleCodexPause: noop,
    onHealthCheck: noop,
    onConnect: noop,
    onDisconnect: noop,
    onOpenTransfer: noop
  }));
  assert.match(pausedHtml, /aria-label="恢复 Codex 操作权"/);
  assert.match(pausedHtml, /role="switch"/);
  assert.match(pausedHtml, /aria-checked="false"/);

  for (const label of ['检查连接', '打开文件舱', '关闭连接']) {
    const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?<\\/button>`))?.[0];
    assert.ok(button, `缺少“${label}”图标按钮及其无障碍名称`);
    assert.match(button, new RegExp(`title="${label}"`), `“${label}”缺少悬停提示`);
    assert.doesNotMatch(button, new RegExp(`>${label}<`), `“${label}”不应显示为按钮文本`);
    assert.match(button, /<svg\b/, `“${label}”应显示图标`);
  }
});
