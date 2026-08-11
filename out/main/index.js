import { app, nativeImage, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import os from "node:os";
import { EventEmitter } from "node:events";
import net from "node:net";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const optionalTrimmedString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? void 0 : value,
  z.string().trim().min(1).optional()
);
const optionalTrimmedStringArray = z.preprocess(
  (value) => Array.isArray(value) ? value.map((item) => typeof item === "string" ? item.trim() : item).filter((item) => item !== "") : value,
  z.array(z.string().trim().min(1)).optional()
);
z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  authMethod: z.enum(["saved_password", "password_prompt", "ssh_agent", "private_key"]),
  privateKeyPath: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(),
  privateKeyPassphraseCredentialId: z.string().min(1).optional(),
  connectTimeoutMs: z.number().int().min(1e3).max(12e4),
  keepaliveIntervalMs: z.number().int().min(5e3).max(3e5),
  jumpHost: z.string().min(1).optional(),
  localTransferRoot: z.string().trim().min(1).optional(),
  remoteTransferRoots: z.array(z.string().trim().min(1)).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  command: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  exitCode: z.number().int().optional(),
  signal: z.string().min(1).optional(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  summary: z.string()
});
const authorizationLevelSchema = z.enum(["ask_every_time", "auto_readonly", "trusted_session"]);
z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().min(1),
  actor: z.enum(["user", "codex", "system"]),
  kind: z.enum(["command", "file_transfer", "control"]),
  status: z.enum([
    "pending_approval",
    "queued",
    "running",
    "completed",
    "failed",
    "rejected",
    "expired",
    "interrupted",
    "paused"
  ]),
  risk: z.enum(["readonly", "write", "high"]),
  summary: z.string(),
  reason: z.string(),
  approvalExpiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
z.object({
  sessionId: z.string().min(1),
  authorizationLevel: authorizationLevelSchema,
  trustedUntil: z.string().datetime().optional(),
  codexPaused: z.boolean(),
  updatedAt: z.string().datetime()
});
z.object({
  kind: z.enum(["desktop", "mcp", "active_action", "retained_session"]),
  id: z.string().min(1),
  updatedAt: z.string().datetime()
});
z.object({
  actionId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
});
z.object({
  sessionId: z.string().min(1),
  authorizationLevel: authorizationLevelSchema,
  trustedUntil: z.string().datetime().optional()
}).superRefine((change, context) => {
  if (change.authorizationLevel === "trusted_session" && !change.trustedUntil) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "信任会话必须设置有效期",
      path: ["trustedUntil"]
    });
  }
});
const hostKeyTrustChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  profileId: z.string().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  oldFingerprint: z.string().min(1).optional(),
  newFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
  risk: z.enum(["first_seen", "changed"])
});
z.object({
  profileId: z.string().min(1),
  challengeId: z.string().uuid()
});
hostKeyTrustChallengeSchema.pick({
  profileId: true,
  host: true,
  port: true
}).extend({
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
  trustedAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  authMethod: z.enum(["saved_password", "password_prompt", "ssh_agent", "private_key"]),
  password: z.string().optional(),
  privateKeyPath: optionalTrimmedString,
  privateKeyPassphrase: z.string().optional(),
  rememberPrivateKeyPassphrase: z.boolean().optional(),
  connectTimeoutMs: z.number().int().min(1e3).max(12e4),
  keepaliveIntervalMs: z.number().int().min(5e3).max(3e5),
  jumpHost: optionalTrimmedString,
  localTransferRoot: optionalTrimmedString,
  remoteTransferRoots: optionalTrimmedStringArray
});
z.object({
  sessionId: z.string().min(1),
  localPath: z.string().min(1),
  remotePath: z.string().min(1),
  direction: z.enum(["upload", "download"])
});
z.object({
  sessionId: z.string().min(1),
  remotePath: z.string().min(1)
});
const portableProfileCredentialsSchema = z.object({
  password: z.string().min(1).max(4096).optional(),
  privateKeyFileName: z.string().min(1).max(255).optional(),
  privateKeyContent: z.string().min(1).max(2e6).optional(),
  privateKeyPassphrase: z.string().min(1).max(4096).optional()
}).strict().refine(
  (credentials) => Boolean(credentials.privateKeyFileName) === Boolean(credentials.privateKeyContent),
  { message: "私钥文件名和内容必须同时提供" }
);
const portableConnectionProfileSchema = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  authMethod: z.enum(["saved_password", "password_prompt", "ssh_agent", "private_key"]),
  privateKeyPath: optionalTrimmedString,
  connectTimeoutMs: z.number().int().min(1e3).max(12e4),
  keepaliveIntervalMs: z.number().int().min(5e3).max(3e5),
  jumpHost: optionalTrimmedString,
  localTransferRoot: optionalTrimmedString,
  remoteTransferRoots: optionalTrimmedStringArray,
  credentials: portableProfileCredentialsSchema.optional()
}).strict().superRefine((profile, context) => {
  if (profile.credentials?.password && profile.authMethod !== "saved_password") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "密码只能用于保存密码认证配置",
      path: ["credentials", "password"]
    });
  }
  const hasPrivateKeySecret = Boolean(
    profile.credentials?.privateKeyContent || profile.credentials?.privateKeyPassphrase
  );
  if (hasPrivateKeySecret && profile.authMethod !== "private_key") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "私钥凭据只能用于私钥认证配置",
      path: ["credentials"]
    });
  }
});
const profileExportDocumentSchema = z.object({
  format: z.literal("orbitssh-connections"),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  includesSecrets: z.boolean(),
  profiles: z.array(portableConnectionProfileSchema).max(1e3)
}).strict().superRefine((document, context) => {
  if (!document.includesSecrets && document.profiles.some((profile) => profile.credentials)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "安全导出文件不能包含凭据",
      path: ["profiles"]
    });
  }
});
function createAppExitFlow(options) {
  let prompting = false;
  let quitAllowed = false;
  const interceptExit = (event) => {
    if (quitAllowed || !options.hasRuntime()) return;
    event.preventDefault();
    if (prompting) return;
    prompting = true;
    void options.choosePolicy().then(async (confirmed) => {
      if (!confirmed) return;
      await options.closeRuntime();
      quitAllowed = true;
      options.allowQuit();
      options.quit();
    }).catch(options.reportError).finally(() => {
      prompting = false;
    });
  };
  return {
    onWindowClose: interceptExit,
    onBeforeQuit: interceptExit
  };
}
function resolveRuntimeEndpoint() {
  if (process.env.ORBITSSH_RUNTIME_ENDPOINT) return process.env.ORBITSSH_RUNTIME_ENDPOINT;
  const identity = `${os.homedir()}\0${os.userInfo().username}`;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return process.platform === "win32" ? `\\\\.\\pipe\\orbitssh-runtime-${suffix}` : path.join(os.tmpdir(), `orbitssh-runtime-${suffix}.sock`);
}
const MAX_FRAME_BYTES = 1024 * 1024;
function encode(frame) {
  return `${JSON.stringify(frame)}
`;
}
function parseFrames(buffer) {
  if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) throw new Error("Runtime 消息超过大小限制");
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const frames = lines.filter(Boolean).map((line) => JSON.parse(line));
  return { frames, rest };
}
class RuntimeRpcClient extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("OrbitSSH Runtime 连接已关闭"));
      this.pending.clear();
      this.emit("close");
    });
  }
  pending = /* @__PURE__ */ new Map();
  buffer = "";
  static async connect(options) {
    const socket = await new Promise((resolve, reject) => {
      const candidate = net.createConnection(options.endpoint);
      candidate.once("connect", () => resolve(candidate));
      candidate.once("error", reject);
    });
    const client = new RuntimeRpcClient(socket);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        client.off("hello", onHello);
        client.off("error", onError);
        client.off("close", onClose);
      };
      const onHello = (protocol) => {
        cleanup();
        if (protocol !== 1) {
          reject(new Error(`不支持的 OrbitSSH Runtime 协议版本：${protocol}`));
          return;
        }
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("OrbitSSH Runtime 握手被拒绝"));
      };
      const timeout = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error("OrbitSSH Runtime 握手超时"));
      }, 5e3);
      client.once("hello", onHello);
      client.once("error", onError);
      client.once("close", onClose);
      socket.write(encode({
        type: "hello",
        protocol: 1,
        authToken: options.authToken,
        clientId: options.clientId ?? randomUUID(),
        kind: options.kind
      }));
    });
    return client;
  }
  call(method, params) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value), reject });
      this.socket.write(encode({ type: "request", id, method, params }));
    });
  }
  async close() {
    if (this.socket.destroyed) return;
    await new Promise((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.end();
    });
  }
  receive(chunk) {
    this.buffer += chunk;
    try {
      const parsed = parseFrames(this.buffer);
      this.buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.type === "hello-ack") {
          this.emit("hello", frame.protocol);
        } else if (frame.type === "event") {
          this.emit(frame.name, frame.data);
        } else if (frame.type === "response") {
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          this.pending.delete(frame.id);
          if (frame.ok) pending.resolve(frame.result);
          else pending.reject(new Error(frame.error));
        }
      }
    } catch (error) {
      this.emit("error", error);
      this.socket.destroy();
    }
  }
}
function resolveAppDataDir() {
  if (process.env.AI_SSH_DATA_DIR) {
    return process.env.AI_SSH_DATA_DIR;
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "AI SSH");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AI SSH");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "ai-ssh");
}
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
async function loadRuntimeAuthToken(kind, dataDir = resolveAppDataDir()) {
  await mkdir(dataDir, { recursive: true });
  const tokenPath = path.join(dataDir, `orbitssh-runtime-${kind}.token`);
  try {
    return validateToken(await readFile(tokenPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile(tokenPath, `${token}
`, { encoding: "utf8", mode: 384, flag: "wx" });
    try {
      await chmod(tokenPath, 384);
    } catch {
    }
    return token;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return validateToken(await readFile(tokenPath, "utf8"));
  }
}
function validateToken(value) {
  const token = value.trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error("OrbitSSH Runtime 身份令牌格式无效");
  return token;
}
const CONNECT_TIMEOUT_MS = 8e3;
const RETRY_INTERVAL_MS = 100;
async function connectRuntime(options) {
  const endpoint = options.endpoint ?? resolveRuntimeEndpoint();
  const authToken = await loadRuntimeAuthToken(options.kind);
  try {
    return await RuntimeRpcClient.connect({ endpoint, kind: options.kind, clientId: options.clientId, authToken });
  } catch (error) {
    if (options.startIfMissing === false || !isMissingRuntime(error)) throw error;
  }
  startRuntimeProcess(endpoint);
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await RuntimeRpcClient.connect({ endpoint, kind: options.kind, clientId: options.clientId, authToken });
    } catch (error) {
      lastError = error;
      if (!isMissingRuntime(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    }
  }
  throw new Error(`无法启动 OrbitSSH Runtime：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
function isMissingRuntime(error) {
  const code = error?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EPIPE";
}
function startRuntimeProcess(endpoint) {
  const entry = resolveRuntimeEntry();
  const executable = resolveRuntimeExecutable(entry);
  const isTypescript = entry.endsWith(".ts");
  const args = isTypescript ? ["--import", "tsx", entry] : [entry];
  const usesElectron = Boolean(process.versions.electron) || path.basename(executable).toLowerCase() === "orbitssh.exe";
  const child = spawn(executable, args, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ORBITSSH_RUNTIME_ENDPOINT: endpoint,
      ...usesElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}
    }
  });
  child.unref();
}
function resolveRuntimeEntry() {
  if (process.env.ORBITSSH_RUNTIME_ENTRY) return process.env.ORBITSSH_RUNTIME_ENTRY;
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(directory, "host-entry.js"),
    path.join(directory, "host-entry.ts"),
    path.resolve(directory, "../runtime/host-entry.js"),
    path.resolve(directory, "../../dist/runtime/host-entry.js"),
    path.resolve(directory, "../../src/runtime/host-entry.ts"),
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "dist", "runtime", "host-entry.js")
  ];
  const entry = candidates.find((candidate) => candidate && existsSync(candidate));
  if (entry) return entry;
  const resourcesDirectory = path.resolve(directory, "..");
  const packagedArchive = path.join(resourcesDirectory, "app.asar");
  if (path.basename(directory).toLowerCase() === "mcp" && existsSync(packagedArchive)) {
    return path.join(packagedArchive, "dist", "runtime", "host-entry.js");
  }
  throw new Error("找不到 OrbitSSH Runtime 启动文件");
}
function resolveRuntimeExecutable(entry) {
  if (process.versions.electron) return process.execPath;
  const marker = `${path.sep}app.asar${path.sep}`;
  const archiveIndex = entry.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (archiveIndex >= 0) {
    const executable = path.resolve(entry.slice(0, archiveIndex), "..", "OrbitSSH.exe");
    if (existsSync(executable)) return executable;
  }
  return process.execPath;
}
const APP_ZOOM_FACTOR = 1.25;
const TITLE_BAR_HEIGHT = 36;
const TITLE_BAR_THEMES = {
  light: { color: "#f3f7f7", symbolColor: "#18383d", height: TITLE_BAR_HEIGHT },
  dark: { color: "#050c10", symbolColor: "#d8efeb", height: TITLE_BAR_HEIGHT },
  green: { color: "#070907", symbolColor: "#a8bea0", height: TITLE_BAR_HEIGHT }
};
app.setName("OrbitSSH");
if (process.platform === "win32") app.setAppUserModelId("com.orbitssh.desktop");
let mainWindow;
let runtime;
const pendingApprovalIds = /* @__PURE__ */ new Set();
const approvalOverlayIcon = nativeImage.createFromDataURL(
  `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#dc2626"/><path d="M16 8v10M16 23v1" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>').toString("base64")}`
);
function updateApprovalAttention() {
  const count = pendingApprovalIds.size;
  if (process.platform === "win32") {
    mainWindow?.setOverlayIcon(count > 0 ? approvalOverlayIcon : null, count > 0 ? "有操作等待审批" : "");
    mainWindow?.flashFrame(count > 0);
  } else if (process.platform === "darwin" && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : "");
  } else if (typeof app.setBadgeCount === "function") {
    app.setBadgeCount(count);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("approval:attention", count);
  }
}
const appExitFlow = createAppExitFlow({
  hasRuntime: () => Boolean(runtime),
  choosePolicy: async () => runtime ? chooseRuntimeExitPolicy(runtime) : true,
  closeRuntime: async () => {
    await runtime?.close();
  },
  allowQuit: () => {
    runtime = void 0;
  },
  quit: () => app.quit(),
  reportError: (error) => {
    void dialog.showErrorBox("鍏抽棴 OrbitSSH 澶辫触", error instanceof Error ? error.message : String(error));
  }
});
async function syncPendingApprovalAttention(client) {
  try {
    const sessions = await client.call("sessions:list", {});
    const actions = await Promise.all(sessions.map(
      (session) => client.call("codriving:events", { sessionId: session.id })
    ));
    pendingApprovalIds.clear();
    for (const action of actions.flat()) {
      if (action.status === "pending_approval") pendingApprovalIds.add(action.id);
    }
    updateApprovalAttention();
  } catch {
  }
}
function resolvePreloadPath() {
  const candidates = [path.join(__dirname, "../preload/index.mjs"), path.join(__dirname, "../preload/index.js")];
  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? candidates[0];
}
function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1375,
    minHeight: 900,
    title: "OrbitSSH",
    show: process.env.ORBITSSH_PACKAGED_SMOKE_TEST !== "1",
    icon: path.join(app.getAppPath(), "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    autoHideMenuBar: true,
    backgroundColor: "#050705",
    ...process.platform === "win32" ? { titleBarStyle: "hidden", titleBarOverlay: TITLE_BAR_THEMES.green } : {},
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = window;
  window.on("close", appExitFlow.onWindowClose);
  window.on("focus", () => window.flashFrame(false));
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = void 0;
  });
  updateApprovalAttention();
  window.webContents.setZoomFactor(APP_ZOOM_FACTOR);
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return window;
}
async function verifyPackagedRenderer(window) {
  if (window.webContents.isLoading()) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("安装版渲染页面加载超时")), 1e4);
      window.webContents.once("did-finish-load", () => {
        clearTimeout(timeout);
        resolve();
      });
      window.webContents.once("did-fail-load", (_event, code, description) => {
        clearTimeout(timeout);
        reject(new Error(`安装版渲染页面加载失败：${code} ${description}`));
      });
    });
  }
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const image = document.querySelector('.workbench-brand-mark img');
      if (!(image instanceof HTMLImageElement)) {
        return { loaded: false, reason: '找不到品牌图标元素' };
      }
      try { await image.decode(); } catch {}
      return {
        loaded: image.complete && image.naturalWidth > 0,
        naturalWidth: image.naturalWidth,
        source: image.currentSrc || image.src
      };
    })()
  `, true);
  if (!result.loaded) {
    throw new Error(`安装版品牌图标加载失败：${result.reason ?? result.source ?? "未知原因"}`);
  }
}
function registerIpc(client) {
  ipcMain.handle("appearance:title-bar-theme", (event, theme) => {
    if (theme !== "light" && theme !== "dark" && theme !== "green") {
      throw new Error("不支持的界面主题");
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (process.platform === "win32" && window) window.setTitleBarOverlay(TITLE_BAR_THEMES[theme]);
  });
  ipcMain.handle("profiles:list", () => client.call("profiles:list", {}));
  ipcMain.handle(
    "profiles:save",
    (_event, input, id) => client.call("profiles:save", { input, id })
  );
  ipcMain.handle("profiles:delete", (_event, id) => client.call("profiles:delete", { profileId: id }));
  ipcMain.handle("profiles:export", async (event) => {
    if ((await client.call("profiles:list", {})).length === 0) {
      throw new Error("当前没有可导出的服务器配置");
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    const choiceOptions = {
      type: "warning",
      title: "导出服务器配置",
      message: "是否在迁移文件中包含密码和私钥？",
      detail: "默认不包含敏感信息。勾选后，密码、私钥文件和私钥口令会写入导出文件；请只保存到可信位置并妥善保管。",
      buttons: ["继续导出", "取消"],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: "包含密码、私钥文件和私钥口令（敏感信息）",
      checkboxChecked: false,
      noLink: true
    };
    const choice = owner ? await dialog.showMessageBox(owner, choiceOptions) : await dialog.showMessageBox(choiceOptions);
    if (choice.response === 1) return void 0;
    const document = await client.call("profiles:export-document", {
      includesSecrets: choice.checkboxChecked
    });
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const saveOptions = {
      title: "导出 OrbitSSH 服务器配置",
      defaultPath: `OrbitSSH-服务器配置-${date}${document.includesSecrets ? "-含敏感信息" : ""}.json`,
      filters: [{ name: "OrbitSSH 配置文件", extensions: ["json"] }]
    };
    const target = owner ? await dialog.showSaveDialog(owner, saveOptions) : await dialog.showSaveDialog(saveOptions);
    if (target.canceled || !target.filePath) return void 0;
    await writeFile(target.filePath, `${JSON.stringify(document, null, 2)}
`, { encoding: "utf8", flag: "w" });
    return {
      filePath: target.filePath,
      count: document.profiles.length,
      includesSecrets: document.includesSecrets
    };
  });
  ipcMain.handle("profiles:import", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const openOptions = {
      title: "导入 OrbitSSH 服务器配置",
      filters: [{ name: "OrbitSSH 配置文件", extensions: ["json"] }],
      properties: ["openFile"]
    };
    const source = owner ? await dialog.showOpenDialog(owner, openOptions) : await dialog.showOpenDialog(openOptions);
    const filePath = source.filePaths[0];
    if (source.canceled || !filePath) return void 0;
    const file = await readFile(filePath);
    if (file.byteLength > 20 * 1024 * 1024) {
      throw new Error("配置文件超过 20 MB，已拒绝导入");
    }
    let document;
    try {
      document = profileExportDocumentSchema.parse(JSON.parse(file.toString("utf8")));
    } catch {
      throw new Error("配置文件格式无效或版本不受支持");
    }
    if (document.includesSecrets) {
      const warningOptions = {
        type: "warning",
        title: "导入敏感配置",
        message: "此配置文件包含密码或私钥",
        detail: "仅在你信任该文件来源时继续。密码会写入系统凭据库，私钥会复制到 OrbitSSH 的本地数据目录。",
        buttons: ["继续导入", "取消"],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      };
      const warning = owner ? await dialog.showMessageBox(owner, warningOptions) : await dialog.showMessageBox(warningOptions);
      if (warning.response === 1) return void 0;
    }
    const result = await client.call("profiles:import-document", {
      document
    });
    return {
      filePath,
      importedCount: result.importedCount,
      skippedCount: result.skippedCount,
      includedSecrets: document.includesSecrets
    };
  });
  ipcMain.handle("sessions:list", () => client.call("sessions:list", {}));
  ipcMain.handle("approval:attention:get", async () => {
    await syncPendingApprovalAttention(client);
    return pendingApprovalIds.size;
  });
  ipcMain.handle(
    "sessions:open",
    (_event, profileId, authorizationLevel) => client.call("sessions:open", { profileId, authorizationLevel })
  );
  ipcMain.handle("host-keys:pending", () => client.call("host-keys:pending", {}));
  ipcMain.handle("host-keys:confirm", async (_event, confirmation) => {
    try {
      await client.call("host-keys:confirm", confirmation);
    } catch {
      throw new Error("主机指纹确认失败。请重新发起连接并通过可信渠道核对指纹后重试。");
    }
  });
  ipcMain.handle("sessions:close", (_event, sessionId) => client.call("sessions:close", { sessionId }));
  ipcMain.handle(
    "sessions:health",
    (_event, sessionId) => client.call("sessions:health", { sessionId })
  );
  ipcMain.handle("commands:run", async (_event, sessionId, command) => {
    const submission = await client.call(
      "commands:request",
      { sessionId, command }
    );
    if (!submission.result) throw new Error(`命令等待用户批准：${submission.action.status}`);
    return submission.result;
  });
  ipcMain.handle("history:list", (_event, sessionId) => client.call("history:list", { sessionId }));
  ipcMain.handle("files:transfer", async (_event, request) => {
    const submission = await client.call(
      "files:request",
      request
    );
    if (!submission.result) throw new Error(`文件操作等待用户批准：${submission.action.status}`);
    return submission.result;
  });
  ipcMain.handle(
    "files:list-remote",
    (_event, sessionId, remotePath) => client.call("files:list-remote", { sessionId, remotePath })
  );
  ipcMain.handle("files:pick-local", async (event, defaultPath) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: "选择要上传的文件",
      defaultPath: typeof defaultPath === "string" && defaultPath.trim() ? defaultPath : void 0,
      properties: ["openFile", "multiSelections"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths.map((filePath) => ({ name: path.basename(filePath), path: filePath }));
  });
  ipcMain.handle("files:pick-download-target", async (event, defaultPath, fileName) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const safeName = path.basename(fileName) || "download";
    const options = {
      title: "保存远程文件",
      defaultPath: typeof defaultPath === "string" && defaultPath.trim() ? path.join(defaultPath, safeName) : safeName
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    return result.canceled ? void 0 : result.filePath;
  });
  ipcMain.handle(
    "terminal:open",
    (_event, sessionId) => client.call("terminal:open", { sessionId })
  );
  ipcMain.handle(
    "terminal:write",
    (_event, sessionId, terminalId, data) => client.call("terminal:write", { sessionId, terminalId, data })
  );
  ipcMain.handle(
    "terminal:submit",
    (_event, sessionId, terminalId, command) => client.call("terminal:submit", { sessionId, terminalId, command })
  );
  ipcMain.handle("terminal:close", (_event, terminalId) => client.call("terminal:close", { terminalId }));
  ipcMain.handle(
    "codriving:events",
    (_event, sessionId, afterSequence) => client.call("codriving:events", { sessionId, afterSequence })
  );
  ipcMain.handle(
    "codriving:approve",
    (_event, approval) => client.call("codriving:approve", approval)
  );
  ipcMain.handle(
    "codriving:reject",
    (_event, approval) => client.call("codriving:reject", approval)
  );
  ipcMain.handle("codriving:pause", (_event, sessionId) => client.call("codriving:pause", { sessionId }));
  ipcMain.handle("codriving:resume", (_event, sessionId) => client.call("codriving:resume", { sessionId }));
  ipcMain.handle(
    "codriving:paused",
    (_event, sessionId) => client.call("codriving:paused", { sessionId })
  );
  ipcMain.handle(
    "codriving:set-authorization",
    (_event, change) => client.call("codriving:set-authorization", change)
  );
  client.on("terminal:data", (chunk) => {
    mainWindow?.webContents.send("terminal:data", chunk);
  });
  client.on("codriving:action-updated", (action) => {
    if (action.status === "pending_approval") pendingApprovalIds.add(action.id);
    else pendingApprovalIds.delete(action.id);
    updateApprovalAttention();
    mainWindow?.webContents.send("codriving:action-updated", action);
  });
  client.on("session:updated", (session) => {
    mainWindow?.webContents.send("session:updated", session);
  });
}
app.whenReady().then(async () => {
  runtime = await connectRuntime({ kind: "desktop" });
  if (process.env.ORBITSSH_PACKAGED_SMOKE_TEST === "1") {
    registerIpc(runtime);
    const smokeWindow = createWindow();
    void syncPendingApprovalAttention(runtime);
    await verifyPackagedRenderer(smokeWindow);
    const screenshotPath = process.env.ORBITSSH_PACKAGED_SMOKE_SCREENSHOT;
    if (screenshotPath) {
      const screenshot = await smokeWindow.webContents.capturePage();
      await writeFile(screenshotPath, screenshot.toPNG());
    }
    await runtime.call("profiles:list", {});
    await runtime.call("runtime:set-exit-policy", { policy: "close_all" });
    smokeWindow.destroy();
    await runtime.close();
    runtime = void 0;
    app.exit(0);
    return;
  }
  registerIpc(runtime);
  createWindow();
  void syncPendingApprovalAttention(runtime);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(async (error) => {
  await dialog.showErrorBox("OrbitSSH 启动失败", error instanceof Error ? error.message : String(error));
  app.exit(1);
});
app.on("before-quit", appExitFlow.onBeforeQuit);
async function chooseRuntimeExitPolicy(client) {
  const sessions = await client.call("sessions:list", {});
  if (sessions.length === 0) {
    await client.call("runtime:set-exit-policy", { policy: "close_all" });
    return true;
  }
  const options = {
    type: "question",
    title: "关闭 OrbitSSH",
    message: "关闭界面后，如何处理当前共驾会话？",
    detail: "选择“Codex 继续”会保留 Runtime、SSH 会话和执行队列；无界面时的高危操作不会执行，会等待重新打开客户端批准并在超时后自动拒绝。",
    buttons: ["仅关闭界面，Codex 继续", "任务完成后关闭", "立即关闭全部能力", "取消"],
    defaultId: 0,
    cancelId: 3,
    noLink: true
  };
  const choice = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  if (choice.response === 3) return false;
  const policies = ["keep_codex", "finish_then_exit", "close_all"];
  await client.call("runtime:set-exit-policy", { policy: policies[choice.response] });
  return true;
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
