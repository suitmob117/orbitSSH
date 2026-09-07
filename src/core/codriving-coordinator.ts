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
import type { CodrivingLedger } from './codriving-ledger';

export type CommandSubmission = CodrivingCommandSubmission;
export type FileTransferSubmission = CodrivingFileTransferSubmission;
export type ApprovedActionSubmission = CodrivingCommandSubmission | CodrivingFileTransferSubmission;

export interface CodrivingExecutionPort {
  getSession(sessionId: string): ConnectionSession;
  setAuthorizationLevel(sessionId: string, authorizationLevel: AuthorizationLevel): ConnectionSession;
  runCommand(sessionId: string, command: string): Promise<CommandResult>;
  executeCommand(
    sessionId: string,
    command: string,
    options?: { echoCommand?: boolean; beforeStart?: () => void }
  ): Promise<CommandResult>;
  executeFileTransfer(request: FileTransferRequest): Promise<FileTransferResult>;
  cancelCommand(sessionId: string): Promise<{ cancelled: boolean }>;
}

class CodexAccessPausedError extends Error {}

export interface CodrivingCoordinatorOptions {
  id?: () => string;
  now?: () => Date;
  approvalTtlMs?: number;
  ledger?: CodrivingLedger;
}

interface PendingCommand {
  action: CodrivingAction;
  command: string;
  useTerminal?: boolean;
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
  private readonly authorizationLevels = new Map<string, AuthorizationLevel>();
  private readonly pausedCodexSessions = new Set<string>();
  private readonly actionListeners = new Set<(action: CodrivingAction) => void>();
  private readonly id: () => string;
  private readonly now: () => Date;
  private readonly approvalTtlMs: number;
  private readonly ledger?: CodrivingLedger;
  private nextSequence = 0;

  constructor(
    private readonly execution: CodrivingExecutionPort,
    options: CodrivingCoordinatorOptions = {}
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.approvalTtlMs = options.approvalTtlMs ?? 30 * 60_000;
    this.ledger = options.ledger;
    this.restoreLedgerState();
  }

  async requestCommand(input: {
    sessionId: string;
    actor: Exclude<CodrivingActor, 'system'>;
    command: string;
  }, options?: { useTerminal?: boolean }): Promise<CommandSubmission> {
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
      this.recordNewAction(action);
      return { action: { ...action } };
    }
    const session = this.currentSession(input.sessionId);
    const assessment = assessCommand(input.command);
    const requiresApproval = this.requiresApproval(input.actor, session.authorizationLevel, assessment.risk);
    const action = this.createAction({
      sessionId: input.sessionId,
      actor: input.actor,
      kind: 'command',
      status: requiresApproval ? 'pending_approval' : 'queued',
      risk: assessment.risk,
      summary: redactCommand(input.command),
      reason: assessment.reason,
      approvalExpiresAt: requiresApproval ? this.approvalExpiry() : undefined,
      binding: { command: input.command }
    });

    this.recordNewAction(action);
    if (action.status === 'pending_approval') {
      this.pendingCommands.set(action.id, { action, command: input.command, useTerminal: options?.useTerminal });
      return { action: { ...action } };
    }

    try {
      const result = await this.executeOrRun(input.sessionId, input.command, action, {
        useTerminal: options?.useTerminal,
        echoCommand: input.actor === 'codex'
      });
      this.settleExecutedAction(action, 'completed');
      return { action: { ...action }, result };
    } catch (error) {
      if (error instanceof CodexAccessPausedError) {
        action.reason = error.message;
        this.updateActionStatus(action, 'paused');
        return { action: { ...action } };
      }
      this.settleExecutedAction(action, 'failed');
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
      this.recordNewAction(action);
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
    this.recordNewAction(action);
    if (action.status === 'pending_approval') {
      this.pendingFileTransfers.set(action.id, { action, request: { ...input.request } });
      return { action: { ...action } };
    }
    try {
      const result = await this.execution.executeFileTransfer(input.request);
      this.settleExecutedAction(action, 'completed');
      return { action: { ...action }, result };
    } catch (error) {
      this.settleExecutedAction(action, 'failed');
      throw error;
    }
  }

  listEvents(sessionId: string, afterSequence = 0): CodrivingAction[] {
    this.expireApprovals();
    return this.events
      .filter((event) => event.sessionId === sessionId && event.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
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
    this.persistSessionState(sessionId);
    this.appendControlEvent(sessionId, '用户已完全接管，Codex 新操作已暂停');
  }

  resumeCodex(sessionId: string): void {
    this.execution.getSession(sessionId);
    this.pausedCodexSessions.delete(sessionId);
    this.persistSessionState(sessionId);
    this.appendControlEvent(sessionId, '用户已恢复 Codex 操作权');
  }

  isCodexPaused(sessionId: string): boolean {
    return this.pausedCodexSessions.has(sessionId);
  }

  async cancelCommand(sessionId: string): Promise<{ cancelled: boolean }> {
    return this.execution.cancelCommand(sessionId);
  }

  onActionChanged(listener: (action: CodrivingAction) => void): () => void {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
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
    const session = this.execution.setAuthorizationLevel(input.sessionId, input.authorizationLevel);
    this.persistSessionState(input.sessionId, session.authorizationLevel);
    return session;
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
      this.updateActionStatus(pending.action, 'queued');
      try {
        const result = await this.executeOrRun(pending.action.sessionId, pending.command, pending.action, {
          useTerminal: pending.useTerminal,
          echoCommand: pending.action.actor === 'codex'
        });
        this.settleExecutedAction(pending.action, 'completed');
        return { action: { ...pending.action }, result };
      } catch (error) {
        if (error instanceof CodexAccessPausedError) {
          pending.action.reason = error.message;
          this.updateActionStatus(pending.action, 'paused');
          return { action: { ...pending.action } };
        }
        this.settleExecutedAction(pending.action, 'failed');
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
    this.updateActionStatus(pendingTransfer.action, 'running');
    try {
      const result = await this.execution.executeFileTransfer(pendingTransfer.request);
      this.settleExecutedAction(pendingTransfer.action, 'completed');
      return { action: { ...pendingTransfer.action }, result };
    } catch (error) {
      this.settleExecutedAction(pendingTransfer.action, 'failed');
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
    this.updateActionStatus(pending.action, 'rejected');
    return { ...pending.action };
  }

  rejectAllPending(reason = 'Runtime 已关闭，待审批操作未执行'): CodrivingAction[] {
    const pending = [...this.pendingCommands.values(), ...this.pendingFileTransfers.values()];
    this.pendingCommands.clear();
    this.pendingFileTransfers.clear();
    return pending.map(({ action }) => {
      action.reason = reason;
      this.updateActionStatus(action, 'rejected');
      return { ...action };
    });
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
    let session = this.execution.getSession(sessionId);
    const persistedLevel = this.authorizationLevels.get(sessionId);
    if (persistedLevel && persistedLevel !== session.authorizationLevel) {
      session = this.execution.setAuthorizationLevel(sessionId, persistedLevel);
    }
    const trustedUntil = this.trustedUntil.get(sessionId);
    if (
      session.authorizationLevel === 'trusted_session' &&
      (!trustedUntil || new Date(trustedUntil).getTime() <= this.now().getTime())
    ) {
      this.trustedUntil.delete(sessionId);
      this.authorizationLevels.set(sessionId, 'ask_every_time');
      const downgraded = this.execution.setAuthorizationLevel(sessionId, 'ask_every_time');
      this.persistSessionState(sessionId, downgraded.authorizationLevel);
      return downgraded;
    }
    return session;
  }

  private codexPauseReason(sessionId: string): string | undefined {
    this.expireApprovals();
    if (this.pausedCodexSessions.has(sessionId)) {
      return '用户已完全接管当前会话，Codex 新操作已暂停';
    }
    const hasPendingApproval = [...this.pendingCommands.values(), ...this.pendingFileTransfers.values()]
      .some((pending) => pending.action.sessionId === sessionId);
    return hasPendingApproval ? '当前会话存在待审批动作，后续 Codex 队列已暂停' : undefined;
  }

  private assertCodexCanStart(sessionId: string): void {
    if (this.pausedCodexSessions.has(sessionId)) {
      throw new CodexAccessPausedError('用户已完全接管当前会话，排队中的 Codex 操作未执行');
    }
  }

  private async executeOrRun(
    sessionId: string,
    command: string,
    action: CodrivingAction,
    options: { useTerminal?: boolean; echoCommand?: boolean }
  ): Promise<CommandResult> {
    if (options.useTerminal) {
      return this.execution.executeCommand(sessionId, command, {
        echoCommand: options.echoCommand,
        beforeStart: () => this.startQueuedCommand(action)
      });
    }
    this.startQueuedCommand(action);
    return this.execution.runCommand(sessionId, command);
  }

  private startQueuedCommand(action: CodrivingAction): void {
    if (action.actor === 'codex') this.assertCodexCanStart(action.sessionId);
    this.updateActionStatus(action, 'running');
  }

  private approvalExpiry(): string {
    return new Date(this.now().getTime() + this.approvalTtlMs).toISOString();
  }

  private expireIfNeeded(action: CodrivingAction): boolean {
    if (!action.approvalExpiresAt || new Date(action.approvalExpiresAt).getTime() > this.now().getTime()) {
      return false;
    }
    this.updateActionStatus(action, 'expired');
    return true;
  }

  private updateActionStatus(action: CodrivingAction, status: CodrivingAction['status']): void {
    action.status = status;
    action.sequence = ++this.nextSequence;
    action.updatedAt = this.now().toISOString();
    let persistenceError: unknown;
    try {
      this.ledger?.recordCodrivingAction({ ...action });
    } catch (error) {
      persistenceError = error;
    }
    this.notifyActionChanged(action);
    if (persistenceError) throw persistenceError;
  }

  private settleExecutedAction(
    action: CodrivingAction,
    status: Extract<CodrivingAction['status'], 'completed' | 'failed'>
  ): void {
    try {
      this.updateActionStatus(action, status);
    } catch {
      action.reason = `${action.reason}；本地共驾账本写入失败，请勿据此重复执行操作`;
      this.notifyActionChanged(action);
    }
  }

  private recordNewAction(action: CodrivingAction): void {
    this.events.push(action);
    this.ledger?.recordCodrivingAction({ ...action });
    this.notifyActionChanged(action);
  }

  private notifyActionChanged(action: CodrivingAction): void {
    for (const listener of this.actionListeners) {
      try {
        listener({ ...action });
      } catch {
        // 界面或 IPC 订阅失败不能改变远端动作的执行结果。
      }
    }
  }

  private persistSessionState(sessionId: string, authorizationLevel?: AuthorizationLevel): void {
    const level = authorizationLevel ?? this.execution.getSession(sessionId).authorizationLevel;
    this.authorizationLevels.set(sessionId, level);
    this.ledger?.saveCodrivingSessionState({
      sessionId,
      authorizationLevel: level,
      trustedUntil: this.trustedUntil.get(sessionId),
      codexPaused: this.pausedCodexSessions.has(sessionId),
      updatedAt: this.now().toISOString()
    });
  }

  private restoreLedgerState(): void {
    if (!this.ledger) return;
    const snapshot = this.ledger.loadCodrivingState();
    const latestActions = new Map<string, CodrivingAction>();
    for (const action of snapshot.actions) {
      this.nextSequence = Math.max(this.nextSequence, action.sequence);
      const existing = latestActions.get(action.id);
      if (!existing || action.sequence > existing.sequence) latestActions.set(action.id, { ...action });
    }
    this.events.push(...latestActions.values());
    for (const state of snapshot.sessions) {
      this.authorizationLevels.set(state.sessionId, state.authorizationLevel);
      if (state.codexPaused) this.pausedCodexSessions.add(state.sessionId);
      if (state.trustedUntil) this.trustedUntil.set(state.sessionId, state.trustedUntil);
    }
    for (const action of this.events) {
      if (action.status !== 'pending_approval' && action.status !== 'queued' && action.status !== 'running') continue;
      action.reason = `${action.reason}；Runtime 已重新启动，未自动重放该操作`;
      this.updateActionStatus(action, 'interrupted');
    }
  }

  private appendControlEvent(sessionId: string, summary: string): void {
    this.recordNewAction(this.createAction({
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
