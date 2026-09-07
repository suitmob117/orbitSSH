import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type {
  AuthorizationLevel,
  ConnectionSession,
  LocalTerminalConfig,
  TerminalChunk,
  TerminalReplay
} from '../shared/types';

interface ManagedLocalTerminal {
  id: string;
  sessionId: string;
  ptyProcess: pty.IPty;
  transcript: string;
}

interface ManagedLocalSession {
  id: string;
  session: ConnectionSession;
  ptyProcess: pty.IPty;
  terminal?: ManagedLocalTerminal;
}

const TERMINAL_TRANSCRIPT_LIMIT = 64 * 1024;

/**
 * 本地终端会话管理器。
 * 使用 node-pty 在本机启动 shell 进程，提供与 SshSessionManager 对齐的事件接口，
 * 使渲染层可以复用同一套终端渲染和数据处理管线。
 *
 * 第一版不接入共驾队列，始终为"完全接管"模式。
 */
export class LocalSessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedLocalSession>();
  private readonly defaultShell: string;

  constructor() {
    super();
    if (process.platform === 'win32') {
      this.defaultShell = process.env.COMSPEC || 'powershell.exe';
    } else {
      this.defaultShell = process.env.SHELL || '/bin/bash';
    }
  }

  async openLocalSession(config?: LocalTerminalConfig): Promise<{
    session: ConnectionSession;
    replay: TerminalReplay;
  }> {
    const sessionId = `local-${randomUUID()}`;
    const shell = config?.shell || this.defaultShell;
    const cwd = config?.cwd || process.cwd();
    const env = this.buildEnv(config?.env);

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env
    });

    const session: ConnectionSession = {
      id: sessionId,
      profileId: sessionId,
      profileName: '本地终端',
      health: 'connected',
      authorizationLevel: 'trusted_session' as AuthorizationLevel,
      kind: 'local',
      openedAt: new Date().toISOString()
    };

    const managed: ManagedLocalSession = {
      id: sessionId,
      session,
      ptyProcess
    };
    this.sessions.set(sessionId, managed);

    ptyProcess.onData((data) => {
      const terminal = managed.terminal;
      if (terminal) {
        this.emitTerminalData(terminal, data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      session.health = 'disconnected';
      this.emit('session-updated', session);
    });

    const replay: TerminalReplay = { sessionId, terminalId: sessionId, chunks: [] };
    return { session, replay };
  }

  async openLocalTerminal(sessionId: string): Promise<{
    terminalId: string;
    replay: TerminalReplay;
  }> {
    const managed = this.getManaged(sessionId);
    if (managed.terminal) {
      const replay: TerminalReplay = {
        sessionId,
        terminalId: managed.terminal.id,
        chunks: [{ sessionId, terminalId: managed.terminal.id, data: managed.terminal.transcript }]
      };
      return { terminalId: managed.terminal.id, replay };
    }

    const terminalId = sessionId;
    const terminal: ManagedLocalTerminal = {
      id: terminalId,
      sessionId,
      ptyProcess: managed.ptyProcess,
      transcript: ''
    };
    managed.terminal = terminal;

    const replay: TerminalReplay = { sessionId, terminalId, chunks: [] };
    return { terminalId, replay };
  }

  writeLocalTerminal(terminalId: string, data: string): void {
    const terminal = this.findTerminal(terminalId);
    terminal.ptyProcess.write(data);
  }

  resizeLocalTerminal(terminalId: string, cols: number, rows: number): void {
    const terminal = this.findTerminal(terminalId);
    terminal.ptyProcess.resize(cols, rows);
  }

  closeLocalTerminal(terminalId: string): void {
    // 本地终端的 PTY 由会话生命周期持有，此处仅解除观察。
    this.findTerminal(terminalId);
  }

  closeLocalSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.ptyProcess.kill();
      this.sessions.delete(sessionId);
    }
  }

  listSessions(): ConnectionSession[] {
    return [...this.sessions.values()].map((managed) => managed.session);
  }

  getSession(sessionId: string): ConnectionSession {
    return this.getManaged(sessionId).session;
  }

  getTerminalReplay(terminalId: string): string {
    return this.findTerminal(terminalId).transcript;
  }

  getTerminalSessionId(terminalId: string): string {
    return this.findTerminal(terminalId).sessionId;
  }

  close(): void {
    for (const managed of this.sessions.values()) {
      managed.ptyProcess.kill();
    }
    this.sessions.clear();
  }

  private emitTerminalData(terminal: ManagedLocalTerminal, data: string): void {
    terminal.transcript = `${terminal.transcript}${data}`.slice(-TERMINAL_TRANSCRIPT_LIMIT);
    const chunk: TerminalChunk = { sessionId: terminal.sessionId, terminalId: terminal.id, data };
    this.emit('terminal-data', chunk);
  }

  private getManaged(sessionId: string): ManagedLocalSession {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      throw new Error(`本地会话不存在：${sessionId}`);
    }
    return managed;
  }

  private findTerminal(terminalId: string): ManagedLocalTerminal {
    for (const managed of this.sessions.values()) {
      if (managed.terminal?.id === terminalId) return managed.terminal;
    }
    throw new Error(`本地终端不存在：${terminalId}`);
  }

  private buildEnv(override?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) base[key] = value;
    }
    if (override) {
      for (const [key, value] of Object.entries(override)) {
        base[key] = value;
      }
    }
    return base;
  }
}
