function requireAbsoluteRemotePath(remotePath: string): string {
  const parts = remotePath.replace(/\\/g, '/').split('/');
  if (!remotePath.startsWith('/') || parts.includes('..')) {
    throw new Error('远程路径必须是绝对路径');
  }
  const normalized = `/${parts.filter((part) => part && part !== '.').join('/')}`;
  return normalized || '/';
}

export function normalizeRemotePath(remotePath: string): string {
  return requireAbsoluteRemotePath(remotePath);
}

export function joinRemotePath(directory: string, fileName: string): string {
  if (!fileName || fileName === '.' || fileName === '..' || /[\\/]/.test(fileName)) {
    throw new Error('文件名无效');
  }
  const normalizedDirectory = normalizeRemotePath(directory);
  return normalizedDirectory === '/'
    ? `/${fileName}`
    : `${normalizedDirectory}/${fileName}`;
}

export function getRemoteParent(directory: string, allowedRoot: string): string {
  const root = normalizeRemotePath(allowedRoot);
  const current = normalizeRemotePath(directory);
  const contained = root === '/'
    ? current.startsWith('/')
    : current === root || current.startsWith(`${root}/`);
  if (!contained || current === root) return root;
  const parent = current.slice(0, current.lastIndexOf('/')) || '/';
  if (root === '/') return parent;
  return parent === root || parent.startsWith(`${root}/`) ? parent : root;
}

export function isRemotePathWithinRoots(remotePath: string, allowedRoots: readonly string[]): boolean {
  let candidate: string;
  try {
    candidate = normalizeRemotePath(remotePath);
  } catch {
    return false;
  }
  return allowedRoots.some((allowedRoot) => {
    try {
      const root = normalizeRemotePath(allowedRoot);
      return root === '/' || candidate === root || candidate.startsWith(`${root}/`);
    } catch {
      return false;
    }
  });
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** unitIndex;
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${Number(value.toFixed(precision))} ${units[unitIndex]}`;
}
