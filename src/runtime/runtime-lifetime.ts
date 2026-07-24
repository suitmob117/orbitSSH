export type RuntimeClientKind = 'desktop' | 'mcp';
export type DesktopExitPolicy = 'keep_codex' | 'finish_then_exit' | 'close_all';

export interface RuntimeLifetimeSnapshot {
  shouldShutdown: boolean;
  retainedSessionIds: string[];
  sessionIdsToClose: string[];
  activeActionCount: number;
  desktopAttached: boolean;
  mcpClientCount: number;
  exitPolicy: DesktopExitPolicy;
}

export class RuntimeLifetime {
  private readonly clients = new Map<string, RuntimeClientKind>();
  private readonly sessions = new Set<string>();
  private readonly retainedSessions = new Set<string>();
  private readonly activeActions = new Set<string>();
  private exitPolicy: DesktopExitPolicy = 'close_all';
  private desktopExitRequested = false;

  attachClient(client: { id: string; kind: RuntimeClientKind }): void {
    this.clients.set(client.id, client.kind);
  }

  detachClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  registerSession(sessionId: string): void {
    this.sessions.add(sessionId);
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.retainedSessions.delete(sessionId);
  }

  retainSession(sessionId: string): void {
    this.sessions.add(sessionId);
    this.retainedSessions.add(sessionId);
  }

  releaseSession(sessionId: string): void {
    this.retainedSessions.delete(sessionId);
  }

  beginAction(actionId: string): void {
    this.activeActions.add(actionId);
  }

  finishAction(actionId: string): void {
    this.activeActions.delete(actionId);
  }

  setDesktopExitPolicy(policy: DesktopExitPolicy): void {
    this.exitPolicy = policy;
    this.desktopExitRequested = true;
  }

  snapshot(): RuntimeLifetimeSnapshot {
    const desktopAttached = [...this.clients.values()].includes('desktop');
    const mcpClientCount = [...this.clients.values()].filter((kind) => kind === 'mcp').length;
    const noClients = this.clients.size === 0;
    const keepForRetainedSession = this.exitPolicy === 'keep_codex' && this.retainedSessions.size > 0;
    const keepForActiveAction = this.exitPolicy !== 'close_all' && this.activeActions.size > 0;
    const desktopGone = this.desktopExitRequested && !desktopAttached;
    const forceClose = desktopGone && this.exitPolicy === 'close_all';
    const finishThenExit = desktopGone && this.exitPolicy === 'finish_then_exit' && this.activeActions.size === 0;
    const shouldShutdown = forceClose || finishThenExit || (noClients && !keepForRetainedSession && !keepForActiveAction);
    return {
      shouldShutdown,
      retainedSessionIds: [...this.retainedSessions],
      sessionIdsToClose: shouldShutdown || this.exitPolicy === 'close_all'
        ? [...this.sessions]
        : [],
      activeActionCount: this.activeActions.size,
      desktopAttached,
      mcpClientCount,
      exitPolicy: this.exitPolicy
    };
  }
}
