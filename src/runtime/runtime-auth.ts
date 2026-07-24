import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveAppDataDir } from '../core/paths';
import type { RuntimeClientKind } from './runtime-lifetime';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/** 不同入口使用不同能力令牌，MCP 令牌不能声明为 desktop 并调用审批方法。 */
export async function loadRuntimeAuthToken(
  kind: RuntimeClientKind,
  dataDir = resolveAppDataDir()
): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const tokenPath = path.join(dataDir, `orbitssh-runtime-${kind}.token`);
  try {
    return validateToken(await readFile(tokenPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const token = randomBytes(32).toString('hex');
  try {
    await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await chmod(tokenPath, 0o600);
    } catch {
      // Windows 权限由当前用户的 AppData ACL 继承；POSIX chmod 是额外收紧。
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return validateToken(await readFile(tokenPath, 'utf8'));
  }
}

export async function loadRuntimeAuthTokens(
  dataDir = resolveAppDataDir()
): Promise<Record<RuntimeClientKind, string>> {
  const [desktop, mcp] = await Promise.all([
    loadRuntimeAuthToken('desktop', dataDir),
    loadRuntimeAuthToken('mcp', dataDir)
  ]);
  return { desktop, mcp };
}

function validateToken(value: string): string {
  const token = value.trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error('OrbitSSH Runtime 身份令牌格式无效');
  return token;
}
