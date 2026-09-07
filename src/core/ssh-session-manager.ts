import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
import type {
  AuthorizationLevel,
  CommandRecord,
  CommandResult,
  ConnectionProfile,
  ConnectionSession,
  FileTransferRequest,
  FileTransferResult,
  HostKeyTrustConfirmation,
  HostKeyTrustChallenge,
  RemoteFileEntry,
  TerminalChunk
} from '../shared/types';
import {
  assessCommand,
  enforceCommandAuthorization,
  enforceTransferAuthorization
} from './command-policy';
import { redactCommand } from './command-redaction';
import { CredentialVault } from './credential-vault';
import { FileBoundary, type FileBoundaryPort } from './file-boundary';
import { HistoryStore } from './history-store';
import type { HostKeyStorePort } from './host-key-store';
import { ProfileStore } from './profile-store';
import { redact, tail } from './redaction';

interface ManagedSession {
  session: ConnectionSession;
  profile: ConnectionProfile;
  client: Client;
  terminal?: ManagedTerminal;
  terminalOpening?: Promise<ManagedTerminal>;
  commandTail: Promise<void>;
}

interface PendingTerminalCommand {
  command: string;
  echoCommand: boolean;
  wrapper: string;
  markerPrefix: string;
  buffer: string;
  stdout: string;
  echoHandled: boolean;
  settled: boolean;
  timeout: NodeJS.Timeout;
  resolve(result: { stdout: string; stderr: string; exitCode?: number }): void;
  reject(error: Error): void;
}

interface ManagedTerminal {
  id: string;
  sessionId: string;
  stream: ClientChannel;
  transcript: string;
  pending?: PendingTerminalCommand;
}

const TERMINAL_TRANSCRIPT_LIMIT = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07]*\x07/g;
const SANITIZE_ENV_PREFIX = 'COMPOSE_PROGRESS=plain NO_COLOR=1 TERM=dumb ';

function sanitizeOutput(raw: string): string {
  return raw
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
    .join('\n');
}

function summarizeCommand(command: string, stdout: string, stderr: string, exitCode?: number): string {
  const risk = assessCommand(command);
  const stdoutLines = stdout.trim() ? stdout.trim().split(/\r?\n/).length : 0;
  const stderrLines = stderr.trim() ? stderr.trim().split(/\r?\n/).length : 0;
  return `Risk: ${risk.risk}; exit code: ${exitCode ?? 'unknown'}; stdout ${stdoutLines} lines; stderr ${stderrLines} lines.`;
}

function formatSshError(error: unknown): string {
  if (error instanceof Error) {
    return redact(error.message);
  }
  return redact(String(error));
}

function sanitizedError(error: unknown): Error {
  return new Error(formatSshError(error));
}

export class SshSessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();
  /** 同一 profile 的握手只允许一个 in-flight Promise，供守卫和并发调用共同使用。 */
  private readonly openingSessions = new Map<string, Promise<ConnectionSession>>();
  private readonly pendingHostKeyChallenges = new Map<string, HostKeyTrustChallenge>();

  constructor(
    private readonly profiles: ProfileStore,
    private readonly credentials: CredentialVault,
    private readonly history: HistoryStore,
    private readonly hostKeys: HostKeyStorePort,
    private readonly clientFactory: () => Client = () => new Client(),
    private readonly fileBoundaryForProfile: (profile: ConnectionProfile) => FileBoundaryPort = (profile) =>
      new FileBoundary({
        localRoot: profile.localTransferRoot,
        remoteRoots: profile.remoteTransferRoots ?? []
      })
  ) {
    super();
  }

  listSessions(): ConnectionSession[] {
    return [...this.sessions.values()].map((managed) => managed.session);
  }

  getSession(sessionId: string): ConnectionSession {
    return this.getManaged(sessionId).session;
  }

  setAuthorizationLevel(sessionId: string, authorizationLevel: AuthorizationLevel): ConnectionSession {
    const session = this.getManaged(sessionId).session;
    session.authorizationLevel = authorizationLevel;
    this.emit('session-updated', session);
    return session;
  }

  assertProfileCanBeUpdated(profileId: string, endpoint: Pick<ConnectionProfile, 'host' | 'port'>): void {
    const active = this.findActiveProfileSession(profileId);
    if (this.openingSessions.has(profileId)) {
      throw new Error('当前配置正在建立会话，请等待连接完成或失败后再修改主机或端口');
    }
    if (active && (active.profile.host !== endpoint.host || active.profile.port !== endpoint.port)) {
      throw new Error('当前配置存在活跃会话，请先关闭会话后再修改主机或端口');
    }
  }

  assertProfileCanBeDeleted(profileId: string): void {
    if (this.openingSessions.has(profileId)) {
      throw new Error('当前配置正在建立会话，请等待连接完成或失败后再删除配置');
    }
    if (this.findActiveProfileSession(profileId)) {
      throw new Error('当前配置存在活跃会话，请先关闭会话后再删除配置');
    }
  }

  listHostKeyTrustChallenges(): HostKeyTrustChallenge[] {
    return [...this.pendingHostKeyChallenges.values()].map((challenge) => ({ ...challenge }));
  }

  async confirmHostKeyTrust(confirmation: HostKeyTrustConfirmation): Promise<void> {
    const pending = this.pendingHostKeyChallenges.get(confirmation.profileId);
    if (!pending || pending.challengeId !== confirmation.challengeId) {
      throw new Error('没有匹配的待确认主机指纹，请重新发起连接并核对风险信息');
    }
    const profile = await this.profiles.get(confirmation.profileId);
    if (profile.host !== pending.host || profile.port !== pending.port) {
      this.pendingHostKeyChallenges.delete(confirmation.profileId);
      throw new Error('连接配置的主机或端口已变化，已丢弃旧指纹确认，请重新连接');
    }
    // await 后重新检查，防止并发确认了已被新握手替换的挑战。
    if (this.pendingHostKeyChallenges.get(confirmation.profileId)?.challengeId !== confirmation.challengeId) {
      throw new Error('主机指纹确认已过期，请重新发起连接并核对风险信息');
    }
    // HostKeyStore 只接受本次握手产生的待确认项，绝不由连接流程自动写入。
    this.hostKeys.confirm(pending);
    this.pendingHostKeyChallenges.delete(confirmation.profileId);
  }

  discardHostKeyChallenge(profileId: string): void {
    this.pendingHostKeyChallenges.delete(profileId);
  }

  discardPendingHostKeyChallenge(profileId: string): void {
    this.discardHostKeyChallenge(profileId);
  }

  async openSession(profileId: string, authorizationLevel?: AuthorizationLevel): Promise<ConnectionSession> {
    const existing = [...this.sessions.values()].find((item) => item.profile.id === profileId);
    if (existing && existing.session.health !== 'disconnected') {
      if (authorizationLevel) existing.session.authorizationLevel = authorizationLevel;
      return existing.session;
    }

    const opening = this.openingSessions.get(profileId);
    if (opening) {
      const session = await opening;
      if (authorizationLevel) session.authorizationLevel = authorizationLevel;
      return session;
    }

    // 在任何 await 之前登记，确保并发 open 与 IPC 配置变更都能看到 in-flight 状态。
    const openingSession = this.openSessionOnce(profileId, authorizationLevel ?? 'ask_every_time');
    this.openingSessions.set(profileId, openingSession);
    try {
      return await openingSession;
    } finally {
      if (this.openingSessions.get(profileId) === openingSession) {
        this.openingSessions.delete(profileId);
      }
    }
  }

  private async openSessionOnce(profileId: string, authorizationLevel: AuthorizationLevel): Promise<ConnectionSession> {
    const profile = await this.profiles.get(profileId);
    const client = this.clientFactory();
    const session: ConnectionSession = {
      id: randomUUID(),
      profileId: profile.id,
      profileName: profile.name,
      health: 'degraded',
      authorizationLevel,
      openedAt: new Date().toISOString()
    };

    const managed: ManagedSession = {
      session,
      profile,
      client,
      commandTail: Promise.resolve()
    };

    client.on('error', (error) => {
      session.health = 'degraded';
      session.lastError = formatSshError(error);
      this.emit('session-updated', session);
    });

    client.on('close', () => {
      session.health = 'disconnected';
      this.emit('session-updated', session);
    });

    await this.connectClient(client, profile);
    session.health = 'connected';
    session.lastCheckedAt = new Date().toISOString();
    this.sessions.set(session.id, managed);
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    const managed = this.getManaged(sessionId);
    managed.terminal?.stream.end();
    managed.client.end();
    managed.session.health = 'disconnected';
    this.sessions.delete(sessionId);
  }

  async cancelCommand(sessionId: string): Promise<{ cancelled: boolean }> {
    const managed = this.getManaged(sessionId);
    let cancelled = false;
    const terminal = managed.terminal;
    if (terminal?.pending) {
      clearTimeout(terminal.pending.timeout);
      terminal.pending.settled = true;
      terminal.pending = undefined;
      try { terminal.stream.write('\x03'); } catch { /* 终端可能已关闭 */ }
      cancelled = true;
    }
    const activeStream = this.activeExecStreams.get(sessionId);
    if (activeStream) {
      try { activeStream.close(); } catch { /* stream 可能已关闭 */ }
      this.activeExecStreams.delete(sessionId);
      cancelled = true;
    }
    return { cancelled };
  }

  async getHealth(sessionId: string): Promise<ConnectionSession> {
    const managed = this.getManaged(sessionId);
    try {
      await this.execRaw(managed.client, 'true', 5000);
      managed.session.health = 'connected';
      managed.session.lastError = undefined;
    } catch (error) {
      managed.session.health = 'degraded';
      managed.session.lastError = formatSshError(error);
    }
    managed.session.lastCheckedAt = new Date().toISOString();
    return managed.session;
  }

  async runCommand(sessionId: string, command: string): Promise<CommandResult> {
    const managed = this.getManaged(sessionId);
    if (managed.session.health === 'disconnected') {
      throw new Error('连接会话已断开，请重新连接');
    }

    enforceCommandAuthorization(managed.session.authorizationLevel, command);
    const startedAt = new Date().toISOString();
    const result = await this.execRaw(managed.client, `${SANITIZE_ENV_PREFIX}${command}`, 120_000, MAX_OUTPUT_BYTES, sessionId);
    const sanitizedResult = {
      ...result,
      stdout: sanitizeOutput(result.stdout),
      stderr: sanitizeOutput(result.stderr)
    };
    return this.recordCommand(sessionId, command, startedAt, sanitizedResult);
  }

  async executeCommand(
    sessionId: string,
    command: string,
    options: { echoCommand?: boolean; beforeStart?: () => void } = {}
  ): Promise<CommandResult> {
    const managed = this.getManaged(sessionId);
    if (managed.session.health === 'disconnected') {
      throw new Error('连接会话已断开，请重新连接');
    }
    const startedAt = new Date().toISOString();
    await this.openTerminal(sessionId);
    const result = await this.enqueueTerminalCommand(
      managed,
      command,
      options.echoCommand ?? true,
      options.beforeStart
    );
    return this.recordCommand(sessionId, command, startedAt, result);
  }

  private async recordCommand(
    sessionId: string,
    command: string,
    startedAt: string,
    result: { stdout: string; stderr: string; exitCode?: number; signal?: string }
  ): Promise<CommandResult> {
    const redactedCommand = redactCommand(command);
    const finishedAt = new Date().toISOString();
    const stdoutTail = tail(result.stdout);
    const stderrTail = tail(result.stderr);
    const record = await this.history.append({
      sessionId,
      command: redactedCommand,
      startedAt,
      finishedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutTail,
      stderrTail,
      summary: summarizeCommand(command, stdoutTail, stderrTail, result.exitCode)
    });

    return {
      record,
      stdout: stdoutTail,
      stderr: stderrTail
    };
  }

  async transferFile(request: FileTransferRequest): Promise<FileTransferResult> {
    const managed = this.getManaged(request.sessionId);
    enforceTransferAuthorization(managed.session.authorizationLevel, request.direction);
    return this.executeFileTransfer(request);
  }

  async executeFileTransfer(request: FileTransferRequest): Promise<FileTransferResult> {
    const managed = this.getManaged(request.sessionId);
    const resolvedPaths = await this.fileBoundaryForProfile(managed.profile).resolve(request);
    const startedAt = new Date().toISOString();

    await new Promise<void>((resolve, reject) => {
      managed.client.sftp((error, sftp) => {
        if (error) {
          reject(sanitizedError(error));
          return;
        }

        const callback = (transferError: Error | null | undefined) => {
          sftp.end();
          if (transferError) {
            reject(sanitizedError(transferError));
          } else {
            resolve();
          }
        };

        if (request.direction === 'upload') {
          sftp.fastPut(resolvedPaths.localPath, resolvedPaths.remotePath, callback);
        } else {
          sftp.fastGet(resolvedPaths.remotePath, resolvedPaths.localPath, callback);
        }
      });
    });

    return {
      id: randomUUID(),
      direction: request.direction,
      localPath: resolvedPaths.localPath,
      remotePath: resolvedPaths.remotePath,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }

  async listRemoteDirectory(sessionId: string, remotePath: string): Promise<RemoteFileEntry[]> {
    const managed = this.getManaged(sessionId);
    const boundary = this.fileBoundaryForProfile(managed.profile);
    const directory = boundary.resolveRemoteBrowsePath(remotePath);

    return new Promise<RemoteFileEntry[]>((resolve, reject) => {
      managed.client.sftp((error, sftp) => {
        if (error) {
          reject(sanitizedError(error));
          return;
        }
        sftp.readdir(directory, (readError, list) => {
          sftp.end();
          if (readError) {
            reject(sanitizedError(readError));
            return;
          }
          const entries = list.flatMap<RemoteFileEntry>((entry) => {
            if (!entry.filename || entry.filename === '.' || entry.filename === '..' || entry.filename.includes('/')) {
              return [];
            }
            let childPath: string;
            try {
              childPath = boundary.resolveRemoteBrowsePath(path.posix.join(directory, entry.filename));
            } catch {
              return [];
            }
            const type = entry.attrs.isDirectory()
              ? 'directory'
              : entry.attrs.isFile()
                ? 'file'
                : entry.attrs.isSymbolicLink()
                  ? 'symlink'
                  : 'other';
            return [{
              name: entry.filename,
              path: childPath,
              type,
              size: entry.attrs.size,
              modifiedAt: entry.attrs.mtime > 0 ? new Date(entry.attrs.mtime * 1000).toISOString() : undefined
            }];
          });
          entries.sort((left, right) => {
            if (left.type === 'directory' && right.type !== 'directory') return -1;
            if (left.type !== 'directory' && right.type === 'directory') return 1;
            return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
          });
          resolve(entries);
        });
      });
    });
  }

  async openTerminal(sessionId: string): Promise<string> {
    const managed = this.getManaged(sessionId);
    if (managed.terminal) return managed.terminal.id;
    if (managed.terminalOpening) return (await managed.terminalOpening).id;
    managed.terminalOpening = this.createTerminal(managed);
    try {
      return (await managed.terminalOpening).id;
    } finally {
      managed.terminalOpening = undefined;
    }
  }

  getTerminalReplay(terminalId: string): string {
    return this.findTerminal(terminalId).transcript;
  }

  getTerminalSessionId(terminalId: string): string {
    return this.findTerminal(terminalId).sessionId;
  }

  private createTerminal(managed: ManagedSession): Promise<ManagedTerminal> {
    const terminalId = randomUUID();
    return new Promise<ManagedTerminal>((resolve, reject) => {
      managed.client.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (error, stream) => {
        if (error) {
          reject(sanitizedError(error));
          return;
        }

        const terminal: ManagedTerminal = {
          id: terminalId,
          sessionId: managed.session.id,
          stream,
          transcript: ''
        };
        managed.terminal = terminal;
        stream.on('data', (data: Buffer) => {
          this.consumeTerminalData(terminal, data.toString('utf8'));
        });
        stream.stderr.on('data', (data: Buffer) => {
          this.emitTerminalData(terminal, data.toString('utf8'));
        });
        stream.on('close', () => {
          if (terminal.pending) {
            clearTimeout(terminal.pending.timeout);
            terminal.pending.reject(new Error('共享终端已关闭，命令未完成'));
            terminal.pending = undefined;
          }
          if (managed.terminal?.id === terminalId) managed.terminal = undefined;
        });
        resolve(terminal);
      });
    });
  }

  runTerminalCommand(sessionId: string, terminalId: string, command: string): void {
    const managed = this.getManaged(sessionId);
    const terminal = managed.terminal;
    if (!terminal || terminal.id !== terminalId) {
      throw new Error(`当前会话中不存在终端：${terminalId}`);
    }
    enforceCommandAuthorization(managed.session.authorizationLevel, command);
    terminal.stream.write(`${command}\r`);
  }

  writeTerminal(terminalId: string, data: string): void {
    const terminal = this.findTerminal(terminalId);
    terminal.stream.write(data);
  }

  closeTerminal(terminalId: string): void {
    // Renderer 离开只会解除观察；共享 PTY 由 Runtime 会话持有，关闭会话时才销毁。
    this.findTerminal(terminalId);
  }

  private enqueueTerminalCommand(
    managed: ManagedSession,
    command: string,
    echoCommand: boolean,
    beforeStart?: () => void
  ): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
    const previous = managed.commandTail;
    let release!: () => void;
    managed.commandTail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(() => {
      beforeStart?.();
      return this.executeTerminalCommand(managed, command, echoCommand);
    }).finally(release);
  }

  private executeTerminalCommand(
    managed: ManagedSession,
    command: string,
    echoCommand: boolean
  ): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
    const terminal = managed.terminal;
    if (!terminal) throw new Error('共享终端尚未建立');
    if (terminal.pending) throw new Error('共享终端仍有前台命令运行，不能启动下一条命令');
    const token = randomUUID().replaceAll('-', '');
    const markerPrefix = `\u001eORBITSSH:${token}:`;
    const wrapper = `${command}; __orbitssh_code=$?; printf '\\036ORBITSSH:${token}:%s\\037' "$__orbitssh_code"\r`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (terminal.pending?.markerPrefix !== markerPrefix) return;
        terminal.pending.settled = true;
        terminal.pending = undefined;
        try { terminal.stream.write('\x03'); } catch { /* 终端可能已关闭 */ }
        reject(new Error('命令执行超时，已强制回收终端状态'));
      }, 120_000);
      terminal.pending = {
        command,
        echoCommand,
        wrapper,
        markerPrefix,
        buffer: '',
        stdout: '',
        echoHandled: false,
        settled: false,
        timeout,
        resolve,
        reject
      };
      terminal.stream.write(wrapper);
    });
  }

  private consumeTerminalData(terminal: ManagedTerminal, data: string): void {
    const pending = terminal.pending;
    if (!pending) {
      this.emitTerminalData(terminal, data);
      return;
    }
    pending.buffer += data;
    if (!pending.echoHandled) {
      const wrapperStart = pending.buffer.indexOf(pending.wrapper);
      if (wrapperStart >= 0) {
        const prefix = pending.buffer.slice(0, wrapperStart);
        if (prefix) this.emitTerminalData(terminal, prefix);
        if (pending.echoCommand) this.emitTerminalData(terminal, `${pending.command}\r`);
        pending.buffer = pending.buffer.slice(wrapperStart + pending.wrapper.length);
        pending.echoHandled = true;
      } else if (pending.buffer.includes(pending.markerPrefix) || pending.buffer.length > pending.wrapper.length + 1024) {
        pending.echoHandled = true;
      } else {
        return;
      }
    }
    const markerStart = pending.buffer.indexOf(pending.markerPrefix);
    if (markerStart < 0) {
      const safeLength = Math.max(0, pending.buffer.length - pending.markerPrefix.length);
      if (safeLength > 0) {
        const visible = pending.buffer.slice(0, safeLength);
        pending.stdout = `${pending.stdout}${visible}`.slice(-TERMINAL_TRANSCRIPT_LIMIT);
        pending.buffer = pending.buffer.slice(safeLength);
        this.emitTerminalData(terminal, visible);
      }
      return;
    }
    const markerEnd = pending.buffer.indexOf('\u001f', markerStart + pending.markerPrefix.length);
    if (markerEnd < 0) return;

    const beforeMarker = pending.buffer.slice(0, markerStart);
    const exitCodeText = pending.buffer.slice(markerStart + pending.markerPrefix.length, markerEnd);
    const afterMarker = pending.buffer.slice(markerEnd + 1);
    const stdout = `${pending.stdout}${beforeMarker}`.replace(/^\r?\n/, '');
    clearTimeout(pending.timeout);
    terminal.pending = undefined;
    if (beforeMarker) {
      // 当命令输出不以换行结尾时，补充换行符以防止下一个 prompt 粘连在同一行。
      const needsNewline = beforeMarker.length > 0
        && !beforeMarker.endsWith('\n')
        && !beforeMarker.endsWith('\r');
      this.emitTerminalData(terminal, needsNewline ? `${beforeMarker}\n` : beforeMarker);
    }
    if (afterMarker) this.emitTerminalData(terminal, afterMarker);
    const exitCode = Number.parseInt(exitCodeText, 10);
    if (!pending.settled) {
      pending.settled = true;
      pending.resolve({ stdout, stderr: '', exitCode: Number.isNaN(exitCode) ? undefined : exitCode });
    }
  }

  private emitTerminalData(terminal: ManagedTerminal, data: string): void {
    terminal.transcript = `${terminal.transcript}${data}`.slice(-TERMINAL_TRANSCRIPT_LIMIT);
    const chunk: TerminalChunk = { sessionId: terminal.sessionId, terminalId: terminal.id, data };
    this.emit('terminal-data', chunk);
  }

  private async connectClient(client: Client, profile: ConnectionProfile): Promise<void> {
    let config: ConnectConfig;
    try {
      config = await this.createConnectConfig(profile);
    } catch (error) {
      throw sanitizedError(error);
    }

    await new Promise<void>((resolve, reject) => {
      let hostKeyFailure: Error | undefined;
      const cleanup = () => {
        client.off('ready', onReady);
        client.off('error', onError);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(hostKeyFailure ?? sanitizedError(error));
      };
      client.once('ready', onReady);
      client.once('error', onError);
      config.hostVerifier = (key: Buffer) => {
        try {
          const challenge = this.createHostKeyChallenge(profile, key);
          if (!challenge) return true;
          this.pendingHostKeyChallenges.set(profile.id, challenge);
          hostKeyFailure = new Error(challenge.risk === 'changed'
            ? 'SSH 主机指纹已变化，已拒绝连接。请在桌面端核对旧/新指纹及中间人攻击风险后确认替换。'
            : '发现未知 SSH 主机指纹，已拒绝连接。请在桌面端核对指纹后确认信任。');
          return false;
        } catch {
          hostKeyFailure = new Error('无法安全读取主机指纹信任记录，已拒绝连接。请检查本地 SQLite 数据库后重试。');
          return false;
        }
      };
      client.connect(config);
    });
  }

  private createHostKeyChallenge(profile: ConnectionProfile, key: Buffer): HostKeyTrustChallenge | undefined {
    const newFingerprint = `SHA256:${createHash('sha256').update(key).digest('base64')}`;
    const trusted = this.hostKeys.get(profile.id);
    if (trusted && trusted.host === profile.host && trusted.port === profile.port && trusted.fingerprint === newFingerprint) {
      return undefined;
    }
    return {
      challengeId: randomUUID(),
      profileId: profile.id,
      host: profile.host,
      port: profile.port,
      oldFingerprint: trusted?.fingerprint,
      newFingerprint,
      risk: trusted ? 'changed' : 'first_seen'
    };
  }

  private async createConnectConfig(profile: ConnectionProfile): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: profile.connectTimeoutMs,
      keepaliveInterval: profile.keepaliveIntervalMs,
      keepaliveCountMax: 3
    };

    if (profile.jumpHost) {
      throw new Error('第一版暂不支持跳板机连接，请先直连服务器');
    }

    if (profile.authMethod === 'saved_password') {
      const password = await this.credentials.getSecret(profile.credentialId);
      if (!password) {
        throw new Error('系统凭据库中没有找到保存的密码');
      }
      config.password = password;
      return config;
    }

    if (profile.authMethod === 'private_key') {
      if (!profile.privateKeyPath) {
        throw new Error('私钥认证需要填写私钥路径');
      }
      config.privateKey = await readFile(profile.privateKeyPath, 'utf8');
      const passphrase = await this.credentials.getSecret(profile.privateKeyPassphraseCredentialId);
      if (passphrase) {
        config.passphrase = passphrase;
      }
      return config;
    }

    if (profile.authMethod === 'ssh_agent') {
      const agent = process.env.SSH_AUTH_SOCK;
      if (!agent) {
        throw new Error('当前环境没有可用的 SSH_AUTH_SOCK，无法使用 SSH Agent');
      }
      config.agent = agent;
      return config;
    }

    throw new Error('每次输入密码模式尚未接入 GUI 密码弹窗，请使用保存密码或私钥');
  }

  private readonly activeExecStreams = new Map<string, import('ssh2').ClientChannel>();

  private execRaw(
    client: Client,
    command: string,
    timeoutMs = 120000,
    maxOutputBytes = MAX_OUTPUT_BYTES,
    trackSessionId?: string
  ): Promise<{ stdout: string; stderr: string; exitCode?: number; signal?: string; truncated?: boolean }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let truncated = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (trackSessionId) this.activeExecStreams.delete(trackSessionId);
          reject(new Error('远程命令执行超时'));
        }
      }, timeoutMs);

      client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timeout);
          if (trackSessionId) this.activeExecStreams.delete(trackSessionId);
          reject(sanitizedError(error));
          return;
        }

        if (trackSessionId) {
          this.activeExecStreams.set(trackSessionId, stream);
          stream.on('close', () => {
            if (this.activeExecStreams.get(trackSessionId) === stream) {
              this.activeExecStreams.delete(trackSessionId);
            }
          });
        }

        stream.on('data', (data: Buffer) => {
          if (!truncated) {
            stdout += data.toString('utf8');
            if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) {
              truncated = true;
              try { stream.close(); } catch { /* 忽略关闭错误 */ }
            }
          }
        });
        stream.stderr.on('data', (data: Buffer) => {
          if (!truncated) {
            stderr += data.toString('utf8');
            if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) {
              truncated = true;
              try { stream.close(); } catch { /* 忽略关闭错误 */ }
            }
          }
        });
        stream.on('close', (exitCode: number, signal: string) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve({ stdout, stderr, exitCode, signal, truncated });
          }
        });
      });
    });
  }

  private getManaged(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      throw new Error(`连接会话不存在：${sessionId}`);
    }
    return managed;
  }

  private findActiveProfileSession(profileId: string): ManagedSession | undefined {
    return [...this.sessions.values()].find((managed) =>
      managed.profile.id === profileId && managed.session.health !== 'disconnected'
    );
  }

  private findTerminal(terminalId: string): ManagedTerminal {
    for (const managed of this.sessions.values()) {
      const terminal = managed.terminal;
      if (terminal?.id === terminalId) return terminal;
    }
    throw new Error(`终端不存在：${terminalId}`);
  }
}
