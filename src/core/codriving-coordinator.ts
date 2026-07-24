import { createHash, randomUUID } from 'node:crypto';

import type {
  AuthorizationLevel,
  CodrivingAction,
  CodrivingActor,
  CodrivingCommandSubmission,
  CodrivingFileTransferSubmission,
  CommandResult,
  ConnectionSession,
  FileTransferRequest,
  FileTransferResult
} from '../shared/types';
import { assessCommand, type CommandRisk } from './command-policy';
import { redactCommand } from './command-redaction';

export type CommandSubmission = CodrivingCommandSubmission;
export type FileTransferSubmission = CodrivingFileTransferSubmission;
export type ApprovedActionSubmission = CodrivingCommandSubmission | CodrivingFileTransferSubmission;

export interface CodrivingExecutionPort {
  getSession(sessionId: string): ConnectionSession;
  setAuthorizationLevel(sessionId: string, authorizationLevel: AuthorizationLevel): ConnectionSession;
  executeCommand(sessionId: string, command: string): Promise<CommandResult>;
  executeFileTransfer(request: FileTransferRequest): Promise<FileTransferResult>;
}

export interface CodrivingCoordinatorOptions {
  id?: () => string;
  now?: () => Date;
  approvalTtlMs?: number;
}

interface PendingCommand {
  action: CodrivingAction;
  command: string;
}

interface PendingFileTransfer {
  action: CodrivingAction;
  request: FileTransferRequest;
}

export class CodrivingCoordinator {
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly pendingFileTransfers = new Map<string, PendingFileTransfer>();
  private readonly events: CodrivingAction[] = [];
  private readonly trustedUntil = new Map<string, string>();
  private readonly pausedCodexSessions = new Set<string>();
  private readonly id: () => string;
  private readonly now: () => Date;
  private readonly approvalTtlMs: number;
  private nextSequence = 0;

  constructor(
    private readonly execution: CodrivingExecutionPort,
    options: CodrivingCoordinatorOptions = {}
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.approvalTtlMs = options.approvalTtlMs ?? 30 * 60_000;
  }

  async requestCommand(input: {
    sessionId: string;
    actor: Exclude<CodrivingActor, 'system'>;
    command: string;
  }): Promise<CommandSubmission> {
    const pauseReason = input.actor === 'codex' ? this.codexPauseReason(input.sessionId) : undefined;
    if (pauseReason) {
      const assessment = assessCommand(input.command);
      const action = this.createAction({
        sessionId: input.sessionId,
        actor: input.actor,
        kind: 'command',
        status: 'paused',
        risk: assessment.risk,
        summary: redactCommand(input.command),
        reason: pauseReason,
        binding: { command: input.command }
      });
      this.events.push(action);
      return { action: { ...action } };
    }
    const session = this.currentSession(input.sessionId);
    const assessment = assessCommand(input.command);
    const requiresApproval = this.requiresApproval(input.actor, session.authorizationLevel, assessment.risk);
    const action = this.createAction({
      sessionId: input.sessionId,
      actor: input.actor,
      kind: 'command',
      status: requiresApproval ? 'pending_approval' : 'running',
      risk: assessment.risk,
      summary: redactCommand(input.command),
      reason: assessment.reason,
      approvalExpiresAt: requiresApproval ? this.approvalExpiry() : undefined,
      binding: { command: input.command }
    });

    this.events.push(action);
    if (action.status === 'pending_approval') {
      this.pendingCommands.set(action.id, { action, command: input.command });
      return { action: { ...action } };
    }

    try {
      const result = await this.execution.executeCommand(input.sessionId, input.command);
      action.status = 'completed';
      action.updatedAt = this.now().toISOString();
      return { action: { ...action }, result };
    } catch (error) {
      action.status = 'failed';
      action.updatedAt = this.now().toISOString();
      throw error;
    }
  }

  async requestFileTransfer(input: {
    actor: Exclude<CodrivingActor, 'system'>;
    request: FileTransferRequest;
  }): Promise<FileTransferSubmission> {
    const pauseReason = input.actor === 'codex' ? this.codexPauseReason(input.request.sessionId) : undefined;
    if (pauseReason) {
      const action = this.createAction({
        sessionId: input.request.sessionId,
        actor: input.actor,
        kind: 'file_transfer',
        status: 'paused',
        risk: input.request.direction === 'download' ? 'readonly' : 'write',
        summary: input.request.direction === 'download' ? '下载文件' : '上传文件',
        reason: pauseReason,
        binding: input.request
      });
      this.events.push(action);
      return { action: { ...action } };
    }
    const session = this.currentSession(input.request.sessionId);
    const risk: CommandRisk = input.request.direction === 'download' ? 'readonly' : 'write';
    const reason = input.request.direction === 'download'
      ? '下载不会修改远程服务器文件'
      : '上传会修改远程服务器文件';
    const requiresApproval = this.requiresApproval(input.actor, session.authorizationLevel, risk);
    const action = this.createAction({
      sessionId: input.request.sessionId,
      actor: input.actor,
      kind: 'file_transfer',
      status: requiresApproval ? 'pending_approval' : 'running',
      risk,
      summary: input.request.direction === 'download' ? '下载文件' : '上传文件',
      reason,
      approvalExpiresAt: requiresApproval ? this.approvalExpiry() : undefined,
      binding: input.request
    });
    this.events.push(action);
    if (action.status === 'pending_approval') {
      this.pendingFileTransfers.set(action.id, { action, request: { ...input.request } });
      return { action: { ...action } };
    }
    try {
      const result = await this.execution.executeFileTransfer(input.request);
      action.status = 'completed';
      action.updatedAt = this.now().toISOString();
      return { action: { ...action }, result };
    } catch (error) {
      action.status = 'failed';
      action.updatedAt = this.now().toISOString();
      throw error;
    }
  }

  listEvents(sessionId: string, afterSequence = 0): CodrivingAction[] {
    this.expireApprovals();
    return this.events
      .filter((event) => event.sessionId === sessionId && event.sequence > afterSequence)
      .map((event) => ({ ...event }));
  }

  expireApprovals(): CodrivingAction[] {
    const expired: CodrivingAction[] = [];
    for (const [actionId, pending] of this.pendingCommands) {
      if (!this.expireIfNeeded(pending.action)) continue;
      this.pendingCommands.delete(actionId);
      expired.push({ ...pending.action });
    }
    for (const [actionId, pending] of this.pendingFileTransfers) {
      if (!this.expireIfNeeded(pending.action)) continue;
      this.pendingFileTransfers.delete(actionId);
      expired.push({ ...pending.action });
    }
    return expired;
  }

  pauseCodex(sessionId: string): void {
    this.execution.getSession(sessionId);
    this.pausedCodexSessions.add(sessionId);
    this.appendControlEvent(sessionId, '用户接管，Codex 已暂停');
  }

  resumeCodex(sessionId: string): void {
    this.execution.getSession(sessionId);
    this.pausedCodexSessions.delete(sessionId);
    this.appendControlEvent(sessionId, '用户恢复 Codex 共驾');
  }

  isCodexPaused(sessionId: string): boolean {
    return this.pausedCodexSessions.has(sessionId);
  }

  setAuthorizationLevel(input: {
    sessionId: string;
    authorizationLevel: AuthorizationLevel;
    trustedUntil?: string;
  }): ConnectionSession {
    if (input.authorizationLevel === 'trusted_session') {
      const expiresAt = input.trustedUntil ? new Date(input.trustedUntil) : undefined;
      if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= this.now().getTime()) {
        throw new Error('信任会话必须设置未来的有效期');
      }
      this.trustedUntil.set(input.sessionId, expiresAt.toISOString());
    } else {
      this.trustedUntil.delete(input.sessionId);
    }
    return this.execution.setAuthorizationLevel(input.sessionId, input.authorizationLevel);
  }

  async approveAction(input: { actionId: string; digest: string }): Promise<ApprovedActionSubmission> {
    const pending = this.pendingCommands.get(input.actionId);
    if (pending) {
      if (pending.action.digest !== input.digest) {
        throw new Error('审批已失效或与待执行动作不匹配');
      }
      if (this.expireIfNeeded(pending.action)) {
        this.pendingCommands.delete(input.actionId);
        throw new Error('审批已过期，操作已自动拒绝');
      }
      this.pendingCommands.delete(input.actionId);
      pending.action.status = 'running';
      pending.action.updatedAt = this.now().toISOString();
      try {
        const result = await this.execution.executeCommand(pending.action.sessionId, pending.command);
        pending.action.status = 'completed';
        pending.action.updatedAt = this.now().toISOString();
        return { action: { ...pending.action }, result };
      } catch (error) {
        pending.action.status = 'failed';
        pending.action.updatedAt = this.now().toISOString();
        throw error;
      }
    }
    const pendingTransfer = this.pendingFileTransfers.get(input.actionId);
    if (!pendingTransfer || pendingTransfer.action.digest !== input.digest) {
      throw new Error('审批已失效或与待执行动作不匹配');
    }
    if (this.expireIfNeeded(pendingTransfer.action)) {
      this.pendingFileTransfers.delete(input.actionId);
      throw new Error('审批已过期，操作已自动拒绝');
    }
    this.pendingFileTransfers.delete(input.actionId);
    pendingTransfer.action.status = 'running';
    pendingTransfer.action.updatedAt = this.now().toISOString();
    try {
      const result = await this.execution.executeFileTransfer(pendingTransfer.request);
      pendingTransfer.action.status = 'completed';
      pendingTransfer.action.updatedAt = this.now().toISOString();
      return { action: { ...pendingTransfer.action }, result };
    } catch (error) {
      pendingTransfer.action.status = 'failed';
      pendingTransfer.action.updatedAt = this.now().toISOString();
      throw error;
    }
  }

  rejectAction(input: { actionId: string; digest: string }): CodrivingAction {
    const pending = this.pendingCommands.get(input.actionId) ?? this.pendingFileTransfers.get(input.actionId);
    if (!pending || pending.action.digest !== input.digest) {
      throw new Error('审批已失效或与待执行动作不匹配');
    }
    this.pendingCommands.delete(input.actionId);
    this.pendingFileTransfers.delete(input.actionId);
    pending.action.status = 'rejected';
    pending.action.updatedAt = this.now().toISOString();
    return { ...pending.action };
  }

  private requiresApproval(
    actor: Exclude<CodrivingActor, 'system'>,
    authorizationLevel: AuthorizationLevel,
    risk: CommandRisk
  ): boolean {
    if (actor === 'user') return risk === 'high';
    if (authorizationLevel === 'ask_every_time') return true;
    if (authorizationLevel === 'auto_readonly') return risk !== 'readonly';
    return risk === 'high';
  }

  private currentSession(sessionId: string): ConnectionSession {
    const session = this.execution.getSession(sessionId);
    const trustedUntil = this.trustedUntil.get(sessionId);
    if (
      session.authorizationLevel === 'trusted_session' &&
      (!trustedUntil || new Date(trustedUntil).getTime() <= this.now().getTime())
    ) {
      this.trustedUntil.delete(sessionId);
      return this.execution.setAuthorizationLevel(sessionId, 'ask_every_time');
    }
    return session;
  }

  private codexPauseReason(sessionId: string): string | undefined {
    this.expireApprovals();
    if (this.pausedCodexSessions.has(sessionId)) {
      return '用户已接管当前会话，Codex 操作暂停';
    }
    const hasPendingApproval = [...this.pendingCommands.values(), ...this.pendingFileTransfers.values()]
      .some((pending) => pending.action.sessionId === sessionId);
    return hasPendingApproval ? '当前会话存在待审批动作，后续 Codex 队列已暂停' : undefined;
  }

  private approvalExpiry(): string {
    return new Date(this.now().getTime() + this.approvalTtlMs).toISOString();
  }

  private expireIfNeeded(action: CodrivingAction): boolean {
    if (!action.approvalExpiresAt || new Date(action.approvalExpiresAt).getTime() > this.now().getTime()) {
      return false;
    }
    action.status = 'expired';
    action.updatedAt = this.now().toISOString();
    return true;
  }

  private appendControlEvent(sessionId: string, summary: string): void {
    this.events.push(this.createAction({
      sessionId,
      actor: 'system',
      kind: 'control',
      status: 'completed',
      risk: 'readonly',
      summary,
      reason: summary
    }));
  }

  private createAction(
    input: Omit<CodrivingAction, 'id' | 'sequence' | 'digest' | 'createdAt' | 'updatedAt'> & { binding?: unknown }
  ): CodrivingAction {
    const { binding, ...visible } = input;
    const id = this.id();
    const sequence = ++this.nextSequence;
    const timestamp = this.now().toISOString();
    const digest = createHash('sha256')
      .update(JSON.stringify({
        id,
        sessionId: visible.sessionId,
        sequence,
        actor: visible.actor,
        kind: visible.kind,
        risk: visible.risk,
        binding: binding ?? visible.summary
      }))
      .digest('hex');
    return { ...visible, id, sequence, digest, createdAt: timestamp, updatedAt: timestamp };
  }
}
