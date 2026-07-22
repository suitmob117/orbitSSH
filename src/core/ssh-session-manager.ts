import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
import type {
  AuthorizationLevel,
  CommandResult,
  ConnectionProfile,
  ConnectionSession,
  FileTransferRequest,
  FileTransferResult,
  HostKeyTrustConfirmation,
  HostKeyTrustChallenge,
  TerminalChunk
} from '../shared/types';
import {
  assessCommand,
  enforceCommandAuthorization,
  enforceTransferAuthorization
} from './command-policy';
import { redactCommand } from './command-redaction';
import { CredentialVault } from './credential-vault';
import { HistoryStore } from './history-store';
import type { HostKeyStorePort } from './host-key-store';
import { ProfileStore } from './profile-store';
import { redact, tail } from './redaction';

interface ManagedSession {
  session: ConnectionSession;
  profile: ConnectionProfile;
  client: Client;
  terminals: Map<string, ClientChannel>;
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
    private readonly clientFactory: () => Client = () => new Client()
  ) {
    super();
  }

  listSessions(): ConnectionSession[] {
    return [...this.sessions.values()].map((managed) => managed.session);
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

  async openSession(profileId: string, authorizationLevel: AuthorizationLevel): Promise<ConnectionSession> {
    const existing = [...this.sessions.values()].find((item) => item.profile.id === profileId);
    if (existing && existing.session.health !== 'disconnected') {
      existing.session.authorizationLevel = authorizationLevel;
      return existing.session;
    }

    const opening = this.openingSessions.get(profileId);
    if (opening) {
      const session = await opening;
      session.authorizationLevel = authorizationLevel;
      return session;
    }

    // 在任何 await 之前登记，确保并发 open 与 IPC 配置变更都能看到 in-flight 状态。
    const openingSession = this.openSessionOnce(profileId, authorizationLevel);
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
      terminals: new Map()
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
    for (const terminal of managed.terminals.values()) {
      terminal.end();
    }
    managed.client.end();
    managed.session.health = 'disconnected';
    this.sessions.delete(sessionId);
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
    const redactedCommand = redactCommand(command);
    const startedAt = new Date().toISOString();
    const result = await this.execRaw(managed.client, command);
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
          sftp.fastPut(request.localPath, request.remotePath, callback);
        } else {
          sftp.fastGet(request.remotePath, request.localPath, callback);
        }
      });
    });

    return {
      id: randomUUID(),
      direction: request.direction,
      localPath: request.localPath,
      remotePath: request.remotePath,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }

  async openTerminal(sessionId: string): Promise<string> {
    const managed = this.getManaged(sessionId);
    const terminalId = randomUUID();

    await new Promise<void>((resolve, reject) => {
      managed.client.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (error, stream) => {
        if (error) {
          reject(sanitizedError(error));
          return;
        }

        managed.terminals.set(terminalId, stream);
        stream.on('data', (data: Buffer) => {
          const chunk: TerminalChunk = {
            sessionId,
            terminalId,
            data: data.toString('utf8')
          };
          this.emit('terminal-data', chunk);
        });
        stream.stderr.on('data', (data: Buffer) => {
          const chunk: TerminalChunk = {
            sessionId,
            terminalId,
            data: data.toString('utf8')
          };
          this.emit('terminal-data', chunk);
        });
        stream.on('close', () => {
          managed.terminals.delete(terminalId);
        });
        resolve();
      });
    });

    return terminalId;
  }

  writeTerminal(terminalId: string, data: string): void {
    const terminal = this.findTerminal(terminalId);
    terminal.write(data);
  }

  closeTerminal(terminalId: string): void {
    const terminal = this.findTerminal(terminalId);
    terminal.end();
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

  private execRaw(
    client: Client,
    command: string,
    timeoutMs = 120000
  ): Promise<{ stdout: string; stderr: string; exitCode?: number; signal?: string }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('远程命令执行超时'));
        }
      }, timeoutMs);

      client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timeout);
          reject(sanitizedError(error));
          return;
        }

        stream.on('data', (data: Buffer) => {
          stdout += data.toString('utf8');
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8');
        });
        stream.on('close', (exitCode: number, signal: string) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve({ stdout, stderr, exitCode, signal });
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

  private findTerminal(terminalId: string): ClientChannel {
    for (const managed of this.sessions.values()) {
      const terminal = managed.terminals.get(terminalId);
      if (terminal) {
        return terminal;
      }
    }
    throw new Error(`终端不存在：${terminalId}`);
  }
}
