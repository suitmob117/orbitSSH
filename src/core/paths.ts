import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function resolveAppDataDir(): string {
  if (process.env.AI_SSH_DATA_DIR) {
    return process.env.AI_SSH_DATA_DIR;
  }

  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'AI SSH');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AI SSH');
  }

  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'ai-ssh');
}

export async function ensureAppDataDir(): Promise<string> {
  const dir = resolveAppDataDir();
  await mkdir(dir, { recursive: true });
  return dir;
}
