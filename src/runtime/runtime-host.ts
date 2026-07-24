import { createCoreServices, type CoreServices } from '../core/services';
import { RuntimeController } from './runtime-controller';
import { resolveRuntimeEndpoint } from './runtime-endpoint';
import { RuntimeRpcServer } from './runtime-rpc';
import type { RuntimeClientKind } from './runtime-lifetime';
import { WindowsApprovalNotifier } from './runtime-notifier';
import type { ApprovalNotifier } from './runtime-notifier';

export interface RuntimeHostOptions {
  endpoint?: string;
  authTokens: Record<RuntimeClientKind, string>;
  services?: CoreServices;
  notifier?: ApprovalNotifier;
  onShutdown?(): void;
}

/** 唯一持有 CoreServices、SSH 连接与 PTY 的后台宿主。 */
export class RuntimeHost {
  readonly endpoint: string;
  private readonly server: RuntimeRpcServer;
  private controller?: RuntimeController;
  private stopping?: Promise<void>;

  constructor(options: RuntimeHostOptions) {
    this.endpoint = options.endpoint ?? resolveRuntimeEndpoint();
    let shutdownQueued = false;
    const requestShutdown = () => {
      if (shutdownQueued) return;
      shutdownQueued = true;
      setTimeout(() => {
        shutdownQueued = false;
        if (!this.controller?.shouldShutdown()) return;
        void this.stop().finally(() => options.onShutdown?.());
      }, 0);
    };
    this.server = new RuntimeRpcServer({
      endpoint: this.endpoint,
      authTokens: options.authTokens,
      handle: (method, params, context) => this.requireController().handle(method, params, context),
      onClientConnected: (context) => this.requireController().clientConnected(context),
      onClientDisconnected: (context) => this.requireController().clientDisconnected(context)
    });
    this.initializeController = () => {
      const services = options.services ?? createCoreServices();
      this.controller = new RuntimeController({
        services,
        notifier: options.notifier ?? new WindowsApprovalNotifier(),
        emit: (name, data) => this.server.broadcast(name, data),
        requestShutdown
      });
    };
  }

  private readonly initializeController: () => void;

  async start(): Promise<void> {
    if (this.controller) return;
    await this.server.start();
    try {
      this.initializeController();
    } catch (error) {
      await this.server.stop();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        await this.server.stop();
        await this.controller?.close();
      })();
    }
    return this.stopping;
  }

  private requireController(): RuntimeController {
    if (!this.controller) throw new Error('OrbitSSH Runtime 正在初始化');
    return this.controller;
  }
}
