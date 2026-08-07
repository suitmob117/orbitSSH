import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { CodrivingCoordinator } from '../core/codriving-coordinator';
import { ProfilePortabilityService } from '../core/profile-portability';
import type { CoreServices } from '../core/services';
import type { CodrivingAction, TerminalChunk } from '../shared/types';
import {
  authorizationLevelSchema,
  codrivingApprovalSchema,
  fileTransferSchema,
  hostKeyTrustConfirmationSchema,
  profileExportDocumentSchema,
  profileInputSchema,
  remoteDirectoryRequestSchema,
  sessionAuthorizationChangeSchema
} from '../shared/validation';
import { RuntimeLifetime, type DesktopExitPolicy } from './runtime-lifetime';
import type { ApprovalNotifier } from './runtime-notifier';
import type { RuntimeRpcContext } from './runtime-rpc';

const idSchema = z.string().min(1);
const sessionRequestSchema = z.object({ sessionId: idSchema }).strict();
const openSessionSchema = z.object({
  profileId: idSchema,
  authorizationLevel: authorizationLevelSchema.optional()
}).strict();
const commandRequestSchema = z.object({
  sessionId: idSchema,
  command: z.string().min(1),
  // actor 可能由旧客户端传入，但 Runtime 永远忽略它并根据连接身份决定来源。
  actor: z.unknown().optional()
}).strict();
const terminalWriteSchema = z.object({ sessionId: idSchema, terminalId: idSchema, data: z.string() }).strict();
const terminalSubmitSchema = z.object({
  sessionId: idSchema,
  terminalId: idSchema,
  command: z.string().trim().min(1).max(32_768)
}).strict();
const actionListSchema = z.object({ sessionId: idSchema, afterSequence: z.number().int().min(0).optional() }).strict();
const exitPolicySchema = z.object({
  policy: z.enum(['keep_codex', 'finish_then_exit', 'close_all'])
}).strict();

const MCP_METHODS = new Set([
  'profiles:list',
  'sessions:list',
  'sessions:open',
  'sessions:health',
  'commands:request',
  'history:list',
  'files:request',
  'files:list-remote',
  'codriving:events',
  'runtime:snapshot'
]);

export interface RuntimeControllerOptions {
  services: CoreServices;
  coordinator?: CodrivingCoordinator;
  lifetime?: RuntimeLifetime;
  portability?: ProfilePortabilityService;
  notifier?: ApprovalNotifier;
  emit?(name: string, data: unknown): void;
  requestShutdown?(): void;
}

/**
 * Runtime 的领域入口。所有跨进程调用都在这里校验、鉴权并绑定真实调用方身份。
 * Electron 和 MCP 只拿到 RPC 结果，永远不会接触 SSH Client、PTY 或凭据对象。
 */
export class RuntimeController {
  private readonly services: CoreServices;
  private readonly coordinator: CodrivingCoordinator;
  private readonly lifetime: RuntimeLifetime;
  private readonly portability: ProfilePortabilityService;
  private readonly unsubscribeActionUpdates: () => void;
  private readonly pendingActionLeases = new Set<string>();
  private readonly approvalTimer: NodeJS.Timeout;

  constructor(private readonly options: RuntimeControllerOptions) {
    this.services = options.services;
    this.coordinator = options.coordinator ?? new CodrivingCoordinator(options.services.sessionManager, {
      ledger: options.services.codrivingLedger
    });
    this.lifetime = options.lifetime ?? new RuntimeLifetime();
    this.portability = options.portability ?? new ProfilePortabilityService(
      options.services.profileStore,
      options.services.credentialVault
    );
    this.unsubscribeActionUpdates = this.coordinator.onActionChanged((action) => this.emitAction(action));
    this.services.sessionManager.on('terminal-data', (chunk: TerminalChunk) => {
      this.options.emit?.('terminal:data', chunk);
    });
    this.services.sessionManager.on('session-updated', (session: unknown) => {
      this.options.emit?.('session:updated', session);
    });
    this.approvalTimer = setInterval(() => this.expireApprovals(), 1_000);
    this.approvalTimer.unref();
  }

  clientConnected(context: RuntimeRpcContext): void {
    this.lifetime.attachClient({ id: context.clientId, kind: context.kind });
    this.emitRuntimeState();
  }

  clientDisconnected(context: RuntimeRpcContext): void {
    this.lifetime.detachClient(context.clientId);
    this.emitRuntimeState();
    if (
      context.kind === 'desktop' &&
      !this.lifetime.snapshot().desktopAttached &&
      this.pendingActionLeases.size > 0
    ) {
      try {
        this.options.notifier?.notifyPendingApproval();
      } catch {
        // 系统通知失败不能改变审批状态，更不能绕过审批。
      }
    }
    if (this.lifetime.snapshot().shouldShutdown) this.options.requestShutdown?.();
  }

  shouldShutdown(): boolean {
    return this.lifetime.snapshot().shouldShutdown;
  }

  async handle(method: string, params: unknown, context: RuntimeRpcContext): Promise<unknown> {
    this.assertMethodAllowed(method, context);

    switch (method) {
      case 'profiles:list':
        return this.services.profileStore.list();
      case 'profiles:save': {
        const input = z.object({ input: profileInputSchema, id: idSchema.optional() }).strict().parse(params);
        if (input.id) this.services.sessionManager.assertProfileCanBeUpdated(input.id, input.input);
        const profile = await this.services.profileStore.save(input.input, input.id);
        this.services.sessionManager.discardHostKeyChallenge(profile.id);
        this.options.emit?.('profiles:updated', await this.services.profileStore.list());
        return profile;
      }
      case 'profiles:delete': {
        const { profileId } = z.object({ profileId: idSchema }).strict().parse(params);
        this.services.sessionManager.assertProfileCanBeDeleted(profileId);
        await this.services.profileStore.delete(profileId);
        this.services.sessionManager.discardHostKeyChallenge(profileId);
        this.options.emit?.('profiles:updated', await this.services.profileStore.list());
        return { ok: true };
      }
      case 'profiles:export-document': {
        const { includesSecrets } = z.object({ includesSecrets: z.boolean() }).strict().parse(params);
        return this.portability.createExport(includesSecrets);
      }
      case 'profiles:import-document': {
        const { document } = z.object({ document: profileExportDocumentSchema }).strict().parse(params);
        const result = await this.portability.importDocument(document);
        this.options.emit?.('profiles:updated', await this.services.profileStore.list());
        return result;
      }
      case 'sessions:list':
        return this.services.sessionManager.listSessions();
      case 'sessions:open': {
        const input = openSessionSchema.parse(params);
        // MCP 无权选择或提升共驾授权；新会话使用安全默认值，已有会话保留桌面端设置。
        const authorizationLevel = context.kind === 'desktop' ? input.authorizationLevel : undefined;
        let session = await this.services.sessionManager.openSession(input.profileId, authorizationLevel);
        if (context.kind === 'desktop' && input.authorizationLevel) {
          session = this.coordinator.setAuthorizationLevel({
            sessionId: session.id,
            authorizationLevel: input.authorizationLevel,
            trustedUntil: input.authorizationLevel === 'trusted_session'
              ? new Date(Date.now() + 60 * 60_000).toISOString()
              : undefined
          });
        }
        this.lifetime.registerSession(session.id);
        this.options.emit?.('session:updated', session);
        this.emitRuntimeState();
        return session;
      }
      case 'host-keys:pending':
        return this.services.sessionManager.listHostKeyTrustChallenges();
      case 'host-keys:confirm': {
        const confirmation = hostKeyTrustConfirmationSchema.parse(params);
        await this.services.sessionManager.confirmHostKeyTrust(confirmation);
        return { ok: true };
      }
      case 'sessions:close': {
        const { sessionId } = sessionRequestSchema.parse(params);
        await this.services.sessionManager.closeSession(sessionId);
        this.lifetime.removeSession(sessionId);
        this.options.emit?.('session:closed', { sessionId });
        this.emitRuntimeState();
        return { ok: true };
      }
      case 'sessions:health': {
        const { sessionId } = sessionRequestSchema.parse(params);
        return this.services.sessionManager.getHealth(sessionId);
      }
      case 'commands:request': {
        const input = commandRequestSchema.parse(params);
        return this.trackAction(() => this.coordinator.requestCommand({
          sessionId: input.sessionId,
          actor: context.kind === 'mcp' ? 'codex' : 'user',
          command: input.command
        }));
      }
      case 'history:list': {
        const input = z.object({ sessionId: idSchema.optional() }).strict().parse(params);
        return this.services.historyStore.list(input.sessionId);
      }
      case 'files:request': {
        const request = fileTransferSchema.parse(params);
        return this.trackAction(() => this.coordinator.requestFileTransfer({
          actor: context.kind === 'mcp' ? 'codex' : 'user',
          request
        }));
      }
      case 'files:list-remote': {
        const input = remoteDirectoryRequestSchema.parse(params);
        return this.services.sessionManager.listRemoteDirectory(input.sessionId, input.remotePath);
      }
      case 'terminal:open': {
        const { sessionId } = sessionRequestSchema.parse(params);
        const terminalId = await this.services.sessionManager.openTerminal(sessionId);
        return { terminalId, replay: this.services.sessionManager.getTerminalReplay(terminalId) };
      }
      case 'terminal:write': {
        const input = terminalWriteSchema.parse(params);
        if (this.services.sessionManager.getTerminalSessionId(input.terminalId) !== input.sessionId) {
          throw new Error('终端与连接会话不匹配');
        }
        this.services.sessionManager.writeTerminal(input.terminalId, input.data);
        return { ok: true };
      }
      case 'terminal:submit': {
        const input = terminalSubmitSchema.parse(params);
        if (this.services.sessionManager.getTerminalSessionId(input.terminalId) !== input.sessionId) {
          throw new Error('终端与连接会话不匹配');
        }
        return this.trackAction(() => this.coordinator.requestCommand({
          sessionId: input.sessionId,
          actor: 'user',
          command: input.command
        }));
      }
      case 'terminal:close': {
        const { terminalId } = z.object({ terminalId: idSchema }).strict().parse(params);
        this.services.sessionManager.closeTerminal(terminalId);
        return { ok: true };
      }
      case 'codriving:events': {
        const input = actionListSchema.parse(params);
        return this.coordinator.listEvents(input.sessionId, input.afterSequence);
      }
      case 'codriving:approve': {
        const approval = codrivingApprovalSchema.parse(params);
        try {
          return await this.trackAction(() => this.coordinator.approveAction(approval));
        } finally {
          this.releasePendingAction(approval.actionId);
        }
      }
      case 'codriving:reject': {
        const approval = codrivingApprovalSchema.parse(params);
        const action = this.coordinator.rejectAction(approval);
        this.releasePendingAction(approval.actionId);
        return action;
      }
      case 'codriving:pause': {
        const { sessionId } = sessionRequestSchema.parse(params);
        this.coordinator.pauseCodex(sessionId);
        return { ok: true };
      }
      case 'codriving:resume': {
        const { sessionId } = sessionRequestSchema.parse(params);
        this.coordinator.resumeCodex(sessionId);
        return { ok: true };
      }
      case 'codriving:paused': {
        const { sessionId } = sessionRequestSchema.parse(params);
        return this.coordinator.isCodexPaused(sessionId);
      }
      case 'codriving:set-authorization': {
        const session = this.coordinator.setAuthorizationLevel(sessionAuthorizationChangeSchema.parse(params));
        this.options.emit?.('session:updated', session);
        return session;
      }
      case 'runtime:set-exit-policy': {
        const { policy } = exitPolicySchema.parse(params);
        await this.setExitPolicy(policy);
        return this.lifetime.snapshot();
      }
      case 'runtime:snapshot':
        return this.lifetime.snapshot();
      default:
        throw new Error(`未知 Runtime 方法：${method}`);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.approvalTimer);
    this.unsubscribeActionUpdates();
    for (const session of this.services.sessionManager.listSessions()) {
      try {
        await this.services.sessionManager.closeSession(session.id);
      } catch {
        // 关闭阶段尽力释放其余会话，最后再统一关闭存储。
      }
    }
    this.services.codrivingLedger?.replaceRuntimeLeases([]);
    this.services.close();
  }

  private assertMethodAllowed(method: string, context: RuntimeRpcContext): void {
    if (context.kind === 'mcp' && !MCP_METHODS.has(method)) {
      throw new Error(`MCP 客户端无权调用 Runtime 方法：${method}`);
    }
  }

  private async trackAction<T extends { action: CodrivingAction }>(operation: () => Promise<T>): Promise<T> {
    const leaseId = randomUUID();
    this.lifetime.beginAction(leaseId);
    this.emitRuntimeState();
    try {
      const result = await operation();
      if (result.action.status === 'pending_approval') {
        this.rememberPendingAction(result.action.id);
        if (!this.lifetime.snapshot().desktopAttached) {
          try {
            this.options.notifier?.notifyPendingApproval();
          } catch {
            // 系统通知失败不能改变审批状态，更不能绕过审批。
          }
        }
      }
      return result;
    } finally {
      this.lifetime.finishAction(leaseId);
      this.emitRuntimeState();
      if (this.lifetime.snapshot().shouldShutdown) this.options.requestShutdown?.();
    }
  }

  private async setExitPolicy(policy: DesktopExitPolicy): Promise<void> {
    const sessions = this.services.sessionManager.listSessions();
    if (policy === 'keep_codex') {
      for (const session of sessions) this.lifetime.retainSession(session.id);
    } else {
      for (const session of sessions) this.lifetime.releaseSession(session.id);
    }
    this.lifetime.setDesktopExitPolicy(policy);
    this.emitRuntimeState();
    if (policy === 'close_all') {
      for (const action of this.coordinator.rejectAllPending()) {
        this.releasePendingAction(action.id);
      }
      for (const session of sessions) {
        await this.services.sessionManager.closeSession(session.id);
        this.lifetime.removeSession(session.id);
      }
      this.options.requestShutdown?.();
    }
  }

  private emitAction(action: CodrivingAction): void {
    this.options.emit?.('codriving:action-updated', action);
  }

  private emitRuntimeState(): void {
    const snapshot = this.lifetime.snapshot();
    this.services.codrivingLedger?.replaceRuntimeLeases(this.lifetime.listLeases());
    this.options.emit?.('runtime:state', snapshot);
  }

  private rememberPendingAction(actionId: string): void {
    if (this.pendingActionLeases.has(actionId)) return;
    this.pendingActionLeases.add(actionId);
    this.lifetime.beginAction(actionId);
    this.emitRuntimeState();
  }

  private releasePendingAction(actionId: string): void {
    if (!this.pendingActionLeases.delete(actionId)) return;
    this.lifetime.finishAction(actionId);
    this.emitRuntimeState();
    if (this.lifetime.snapshot().shouldShutdown) this.options.requestShutdown?.();
  }

  private expireApprovals(): void {
    for (const action of this.coordinator.expireApprovals()) {
      this.releasePendingAction(action.id);
    }
  }
}
