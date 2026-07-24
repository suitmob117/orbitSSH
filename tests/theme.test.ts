import assert from 'node:assert/strict';
import test from 'node:test';

import { parseThemePreference, resolveTheme } from '../src/renderer/src/lib/theme';

test('复古绿是新安装默认主题，同时保留浅色、深色和跟随系统选项', () => {
  assert.equal(parseThemePreference(null), 'green');
  assert.equal(parseThemePreference('legacy-theme'), 'green');
  assert.equal(parseThemePreference('green'), 'green');
  assert.equal(parseThemePreference('light'), 'light');
  assert.equal(parseThemePreference('dark'), 'dark');
  assert.equal(parseThemePreference('system'), 'system');
});

test('仅跟随系统选项读取系统深浅偏好', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('green', true), 'green');
  assert.equal(resolveTheme('light', true), 'light');
});
