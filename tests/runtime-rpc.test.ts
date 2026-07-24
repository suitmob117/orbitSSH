import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RuntimeRpcClient, RuntimeRpcServer } from '../src/runtime/runtime-rpc';

const AUTH_TOKENS = { desktop: 'a'.repeat(64), mcp: 'b'.repeat(64) };

function waitForEvent<T>(client: RuntimeRpcClient, event: string): Promise<T> {
  return new Promise((resolve) => client.once(event, (value) => resolve(value as T)));
}

function testEndpoint(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\orbitssh-test-${process.pid}-${randomUUID()}`
    : path.join(os.tmpdir(), `orbitssh-test-${process.pid}-${randomUUID()}.sock`);
}

test('桌面客户端退出后，MCP 客户端仍访问同一个 Runtime 状态', async (context) => {
  const endpoint = testEndpoint();
  let sharedValue = 'initial';
  const server = new RuntimeRpcServer({
    endpoint,
    authTokens: AUTH_TOKENS,
    handle: async (method, params) => {
      if (method === 'state:set') {
        sharedValue = String((params as { value: unknown }).value);
        return { ok: true };
      }
      if (method === 'state:get') return { value: sharedValue };
      throw new Error('未知方法');
    }
  });
  await server.start();
  context.after(async () => server.stop());

  const desktop = await RuntimeRpcClient.connect({ endpoint, kind: 'desktop', authToken: AUTH_TOKENS.desktop });
  await desktop.call('state:set', { value: 'shared-session' });
  await desktop.close();

  const mcp = await RuntimeRpcClient.connect({ endpoint, kind: 'mcp', authToken: AUTH_TOKENS.mcp });
  context.after(async () => mcp.close());
  assert.deepEqual(await mcp.call('state:get', {}), { value: 'shared-session' });
});

test('Runtime 将事件广播给所有已完成握手的客户端', async (context) => {
  const endpoint = testEndpoint();
  const server = new RuntimeRpcServer({ endpoint, authTokens: AUTH_TOKENS, handle: async () => ({ ok: true }) });
  await server.start();
  context.after(async () => server.stop());

  const desktop = await RuntimeRpcClient.connect({ endpoint, kind: 'desktop', authToken: AUTH_TOKENS.desktop });
  const mcp = await RuntimeRpcClient.connect({ endpoint, kind: 'mcp', authToken: AUTH_TOKENS.mcp });
  context.after(async () => Promise.all([desktop.close(), mcp.close()]));
  const desktopEvent = waitForEvent<{ sessionId: string }>(desktop, 'session:updated');
  const mcpEvent = waitForEvent<{ sessionId: string }>(mcp, 'session:updated');

  server.broadcast('session:updated', { sessionId: 'shared-session' });

  assert.deepEqual(await desktopEvent, { sessionId: 'shared-session' });
  assert.deepEqual(await mcpEvent, { sessionId: 'shared-session' });
});

test('Runtime 将未知方法错误返回给调用方且连接保持可用', async (context) => {
  const endpoint = testEndpoint();
  const server = new RuntimeRpcServer({
    endpoint,
    authTokens: AUTH_TOKENS,
    handle: async (method) => {
      if (method === 'health') return { ok: true };
      throw new Error(`未知 Runtime 方法：${method}`);
    }
  });
  await server.start();
  context.after(async () => server.stop());
  const client = await RuntimeRpcClient.connect({ endpoint, kind: 'desktop', authToken: AUTH_TOKENS.desktop });
  context.after(async () => client.close());

  await assert.rejects(client.call('not-allowed', {}), /未知 Runtime 方法/);
  assert.deepEqual(await client.call('health', {}), { ok: true });
});

test('Runtime 连接中断后拒绝所有尚未完成的请求', async (context) => {
  const endpoint = testEndpoint();
  const server = new RuntimeRpcServer({
    endpoint,
    authTokens: AUTH_TOKENS,
    handle: async () => new Promise(() => undefined)
  });
  await server.start();
  const client = await RuntimeRpcClient.connect({ endpoint, kind: 'mcp', authToken: AUTH_TOKENS.mcp });
  context.after(async () => client.close());

  const pending = client.call('wait-forever', {});
  await server.stop();

  await assert.rejects(pending, /Runtime 连接已关闭/);
});

test('Runtime 通过连接回调维护桌面与 MCP 租约', async (context) => {
  const endpoint = testEndpoint();
  const connected: string[] = [];
  const disconnected: string[] = [];
  const server = new RuntimeRpcServer({
    endpoint,
    authTokens: AUTH_TOKENS,
    handle: async () => ({ ok: true }),
    onClientConnected: (client) => connected.push(`${client.kind}:${client.clientId}`),
    onClientDisconnected: (client) => disconnected.push(`${client.kind}:${client.clientId}`)
  });
  await server.start();
  context.after(async () => server.stop());

  const desktop = await RuntimeRpcClient.connect({ endpoint, kind: 'desktop', clientId: 'desktop-1', authToken: AUTH_TOKENS.desktop });
  const mcp = await RuntimeRpcClient.connect({ endpoint, kind: 'mcp', clientId: 'mcp-1', authToken: AUTH_TOKENS.mcp });
  assert.deepEqual(connected, ['desktop:desktop-1', 'mcp:mcp-1']);

  await desktop.close();
  await mcp.close();
  assert.deepEqual(disconnected, ['desktop:desktop-1', 'mcp:mcp-1']);
});

test('Runtime 拒绝没有当前用户身份令牌的客户端', async (context) => {
  const endpoint = testEndpoint();
  const server = new RuntimeRpcServer({ endpoint, authTokens: AUTH_TOKENS, handle: async () => ({ ok: true }) });
  await server.start();
  context.after(async () => server.stop());

  await assert.rejects(
    RuntimeRpcClient.connect({ endpoint, kind: 'mcp', authToken: AUTH_TOKENS.desktop }),
    /握手被拒绝/
  );
});
