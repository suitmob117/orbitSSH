import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** 当前系统用户独占的稳定端点；固定名称让 Electron 与 MCP 能找到同一个 Runtime。 */
export function resolveRuntimeEndpoint(): string {
  if (process.env.ORBITSSH_RUNTIME_ENDPOINT) return process.env.ORBITSSH_RUNTIME_ENDPOINT;
  const identity = `${os.homedir()}\0${os.userInfo().username}`;
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\orbitssh-runtime-${suffix}`
    : path.join(os.tmpdir(), `orbitssh-runtime-${suffix}.sock`);
}
