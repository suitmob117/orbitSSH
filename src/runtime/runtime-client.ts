import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { RuntimeClientKind } from './runtime-lifetime';
import { resolveRuntimeEndpoint } from './runtime-endpoint';
import { RuntimeRpcClient } from './runtime-rpc';
import { loadRuntimeAuthToken } from './runtime-auth';

const CONNECT_TIMEOUT_MS = 8_000;
const RETRY_INTERVAL_MS = 100;

export interface ConnectRuntimeOptions {
  kind: RuntimeClientKind;
  endpoint?: string;
  clientId?: string;
  startIfMissing?: boolean;
}

export async function connectRuntime(options: ConnectRuntimeOptions): Promise<RuntimeRpcClient> {
  const endpoint = options.endpoint ?? resolveRuntimeEndpoint();
  const authToken = await loadRuntimeAuthToken(options.kind);
  try {
    return await RuntimeRpcClient.connect({ endpoint, kind: options.kind, clientId: options.clientId, authToken });
  } catch (error) {
    if (options.startIfMissing === false || !isMissingRuntime(error)) throw error;
  }

  startRuntimeProcess(endpoint);
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await RuntimeRpcClient.connect({ endpoint, kind: options.kind, clientId: options.clientId, authToken });
    } catch (error) {
      lastError = error;
      if (!isMissingRuntime(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    }
  }
  throw new Error(`无法启动 OrbitSSH Runtime：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function isMissingRuntime(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE';
}

function startRuntimeProcess(endpoint: string): void {
  const entry = resolveRuntimeEntry();
  const executable = resolveRuntimeExecutable(entry);
  const isTypescript = entry.endsWith('.ts');
  const args = isTypescript ? ['--import', 'tsx', entry] : [entry];
  const usesElectron = Boolean(process.versions.electron) || path.basename(executable).toLowerCase() === 'orbitssh.exe';
  const child = spawn(executable, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ORBITSSH_RUNTIME_ENDPOINT: endpoint,
      ...(usesElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
    }
  });
  child.unref();
}

function resolveRuntimeEntry(): string {
  if (process.env.ORBITSSH_RUNTIME_ENTRY) return process.env.ORBITSSH_RUNTIME_ENTRY;
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(directory, 'host-entry.js'),
    path.join(directory, 'host-entry.ts'),
    path.resolve(directory, '../runtime/host-entry.js'),
    path.resolve(directory, '../../dist/runtime/host-entry.js'),
    path.resolve(directory, '../../src/runtime/host-entry.ts'),
    path.join(process.resourcesPath ?? '', 'app.asar.unpacked', 'dist', 'runtime', 'host-entry.js')
  ];
  const entry = candidates.find((candidate) => candidate && existsSync(candidate));
  if (entry) return entry;

  // 安装版 MCP 位于 resources/mcp，普通 Node 无法读取 ASAR 内部路径，
  // 但可以把该路径交给同目录上层的 OrbitSSH Electron 可执行文件启动。
  const resourcesDirectory = path.resolve(directory, '..');
  const packagedArchive = path.join(resourcesDirectory, 'app.asar');
  if (path.basename(directory).toLowerCase() === 'mcp' && existsSync(packagedArchive)) {
    return path.join(packagedArchive, 'dist', 'runtime', 'host-entry.js');
  }
  throw new Error('找不到 OrbitSSH Runtime 启动文件');
}

function resolveRuntimeExecutable(entry: string): string {
  if (process.versions.electron) return process.execPath;
  const marker = `${path.sep}app.asar${path.sep}`;
  const archiveIndex = entry.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (archiveIndex >= 0) {
    const executable = path.resolve(entry.slice(0, archiveIndex), '..', 'OrbitSSH.exe');
    if (existsSync(executable)) return executable;
  }
  return process.execPath;
}
