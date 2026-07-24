import { realpath } from 'node:fs/promises';
import path from 'node:path';

export type FileTransferDirection = 'upload' | 'download';

export interface FileBoundaryOptions {
  localRoot?: string;
  remoteRoots: readonly string[];
}

export interface FileBoundaryRequest {
  direction: FileTransferDirection;
  localPath: string;
  remotePath: string;
}

export interface ResolvedFileTransferPaths {
  localPath: string;
  remotePath: string;
}

export interface FileBoundaryPort {
  resolve(request: FileBoundaryRequest): Promise<ResolvedFileTransferPaths>;
  resolveRemotePath(remotePath: string): string;
  resolveRemoteBrowsePath(remotePath: string): string;
}

/**
 * 将本地真实路径、下载目标父目录和远程 POSIX 路径的检查收敛在一个模块中。
 * 调用方只能取得已标准化且位于配置目录内的路径，不能自行声明允许根目录。
 */
export class FileBoundary implements FileBoundaryPort {
  constructor(private readonly options: FileBoundaryOptions) {}

  async resolve(request: FileBoundaryRequest): Promise<ResolvedFileTransferPaths> {
    const localPath = request.direction === 'upload'
      ? await this.resolveUploadSource(request.localPath)
      : await this.resolveDownloadTarget(request.localPath);
    return { localPath, remotePath: this.resolveRemotePath(request.remotePath) };
  }

  private async resolveUploadSource(localPath: string): Promise<string> {
    const root = await this.resolveLocalRoot();
    const candidate = await this.resolveExistingPath(localPath, '本地上传文件不存在或无法解析');
    this.assertLocalContained(root, candidate);
    return candidate;
  }

  private async resolveDownloadTarget(localPath: string): Promise<string> {
    const root = await this.resolveLocalRoot();
    const parent = await this.resolveExistingPath(path.dirname(localPath), '本地下载目录不存在或无法解析');
    this.assertLocalContained(root, parent);

    try {
      const existingTarget = await realpath(localPath);
      this.assertLocalContained(root, existingTarget);
      return existingTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('本地下载目标无法安全解析');
      }
      const target = path.join(parent, path.basename(localPath));
      this.assertLocalContained(root, target);
      return target;
    }
  }

  private async resolveLocalRoot(): Promise<string> {
    if (!this.options.localRoot?.trim()) {
      throw new Error('未配置本地文件传输允许目录');
    }
    return this.resolveExistingPath(this.options.localRoot, '本地文件传输允许目录不存在或无法解析');
  }

  private async resolveExistingPath(candidate: string, message: string): Promise<string> {
    try {
      return await realpath(candidate);
    } catch {
      throw new Error(message);
    }
  }

  private assertLocalContained(root: string, candidate: string): void {
    const compareRoot = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
    const compareCandidate = process.platform === 'win32' ? candidate.toLocaleLowerCase() : candidate;
    const relative = path.relative(compareRoot, compareCandidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('本地文件路径不在允许目录内');
    }
  }

  resolveRemotePath(remotePath: string): string {
    if (!this.options.remoteRoots.length) {
      throw new Error('未配置远程文件传输允许目录');
    }
    const normalized = this.normalizeRemotePath(remotePath, '远程文件路径不在允许目录内');
    const allowed = this.options.remoteRoots.some((root) => this.isRemoteContained(root, normalized));
    if (!allowed) {
      throw new Error('远程文件路径不在允许目录内');
    }
    return normalized;
  }

  resolveRemoteBrowsePath(remotePath: string): string {
    return this.normalizeRemotePath(remotePath, '远程浏览路径无效');
  }

  private normalizeRemotePath(remotePath: string, message: string): string {
    if (!remotePath.startsWith('/') || remotePath.split('/').includes('..') || remotePath.includes('\0')) {
      throw new Error(message);
    }
    return path.posix.normalize(remotePath);
  }

  private isRemoteContained(root: string, candidate: string): boolean {
    if (!root.startsWith('/') || root.split('/').includes('..')) return false;
    const normalizedRoot = path.posix.normalize(root);
    return normalizedRoot === '/'
      ? candidate.startsWith('/')
      : candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
  }
}
