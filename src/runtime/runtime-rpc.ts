import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net, { type Server, type Socket } from 'node:net';

import type { RuntimeClientKind } from './runtime-lifetime';

const MAX_FRAME_BYTES = 1024 * 1024;

type RpcRequest = { type: 'request'; id: string; method: string; params: unknown };
type RpcResponse = { type: 'response'; id: string; ok: true; result: unknown } | {
  type: 'response'; id: string; ok: false; error: string;
};
type RpcHello = { type: 'hello'; protocol: 1; clientId: string; kind: RuntimeClientKind; authToken: string };
type RpcHelloAck = { type: 'hello-ack'; protocol: 1 };
type RpcEvent = { type: 'event'; name: string; data: unknown };
type RpcFrame = RpcRequest | RpcResponse | RpcHello | RpcHelloAck | RpcEvent;

export interface RuntimeRpcContext {
  clientId: string;
  kind: RuntimeClientKind;
}

export interface RuntimeRpcServerOptions {
  endpoint: string;
  authTokens: Record<RuntimeClientKind, string>;
  handle(method: string, params: unknown, context: RuntimeRpcContext): Promise<unknown>;
  onClientConnected?(context: RuntimeRpcContext): void;
  onClientDisconnected?(context: RuntimeRpcContext): void;
}

function encode(frame: RpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseFrames(buffer: string): { frames: RpcFrame[]; rest: string } {
  if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) throw new Error('Runtime 消息超过大小限制');
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const frames = lines.filter(Boolean).map((line) => JSON.parse(line) as RpcFrame);
  return { frames, rest };
}

export class RuntimeRpcServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly contexts = new Map<Socket, RuntimeRpcContext>();

  constructor(private readonly options: RuntimeRpcServerOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server?.once('error', onError);
      this.server?.once('listening', onListening);
      this.server?.listen(this.options.endpoint);
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.contexts.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  broadcast(name: string, data: unknown): void {
    const frame = encode({ type: 'event', name, data });
    for (const socket of this.sockets) {
      if (this.contexts.has(socket) && socket.writable) socket.write(frame);
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      try {
        const parsed = parseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) void this.receive(socket, frame);
      } catch {
        socket.destroy();
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      const context = this.contexts.get(socket);
      this.contexts.delete(socket);
      if (context) this.options.onClientDisconnected?.(context);
    });
  }

  private async receive(socket: Socket, frame: RpcFrame): Promise<void> {
    if (!this.contexts.has(socket)) {
      if (
        frame.type !== 'hello' || frame.protocol !== 1 ||
        !frame.clientId || !['desktop', 'mcp'].includes(frame.kind)
      ) {
        socket.destroy();
        return;
      }
      if (frame.authToken !== this.options.authTokens[frame.kind]) {
        socket.destroy();
        return;
      }
      const context = { clientId: frame.clientId, kind: frame.kind };
      this.contexts.set(socket, context);
      this.options.onClientConnected?.(context);
      socket.write(encode({ type: 'hello-ack', protocol: 1 }));
      return;
    }
    if (frame.type !== 'request') return;
    try {
      const result = await this.options.handle(frame.method, frame.params, this.contexts.get(socket)!);
      socket.write(encode({ type: 'response', id: frame.id, ok: true, result }));
    } catch (error) {
      socket.write(encode({ type: 'response', id: frame.id, ok: false, error: safeError(error) }));
    }
  }
}

export class RuntimeRpcClient extends EventEmitter {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private buffer = '';

  private constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('OrbitSSH Runtime 连接已关闭'));
      this.pending.clear();
      this.emit('close');
    });
  }

  static async connect(options: {
    endpoint: string;
    kind: RuntimeClientKind;
    authToken: string;
    clientId?: string;
  }): Promise<RuntimeRpcClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = net.createConnection(options.endpoint);
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', reject);
    });
    const client = new RuntimeRpcClient(socket);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        client.off('hello', onHello);
        client.off('error', onError);
        client.off('close', onClose);
      };
      const onHello = (protocol: number) => {
        cleanup();
        if (protocol !== 1) {
          reject(new Error(`不支持的 OrbitSSH Runtime 协议版本：${protocol}`));
          return;
        }
        resolve();
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error('OrbitSSH Runtime 握手被拒绝')); };
      const timeout = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error('OrbitSSH Runtime 握手超时'));
      }, 5_000);
      client.once('hello', onHello);
      client.once('error', onError);
      client.once('close', onClose);
      socket.write(encode({
        type: 'hello',
        protocol: 1,
        authToken: options.authToken,
        clientId: options.clientId ?? randomUUID(),
        kind: options.kind
      }));
    });
    return client;
  }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.write(encode({ type: 'request', id, method, params }));
    });
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.end();
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    try {
      const parsed = parseFrames(this.buffer);
      this.buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.type === 'hello-ack') {
          this.emit('hello', frame.protocol);
        } else if (frame.type === 'event') {
          this.emit(frame.name, frame.data);
        } else if (frame.type === 'response') {
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          this.pending.delete(frame.id);
          if (frame.ok) pending.resolve(frame.result);
          else pending.reject(new Error(frame.error));
        }
      }
    } catch (error) {
      this.emit('error', error);
      this.socket.destroy();
    }
  }
}
