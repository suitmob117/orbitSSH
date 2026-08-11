import assert from 'node:assert/strict';
import test from 'node:test';
import { highlightServerPrompt } from '../src/renderer/src/lib/terminal-output';

test('server prompt paths use a distinct color while normal output stays unchanged', () => {
  const highlighted = highlightServerPrompt('[root@host /opt/portal-data-server]# ls\r\n');

  assert.match(highlighted, /\[root@host \x1b\[38;2;112;207;255m\/opt\/portal-data-server\x1b\[0m\]#/);
  assert.match(highlighted, / ls\r\n$/);
  assert.equal(highlightServerPrompt('portal-data-server\r\n'), 'portal-data-server\r\n');
});
