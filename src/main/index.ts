import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AppTheme,
  CommandResult,
  CodrivingAction,
  CodrivingApproval,
  CodrivingCommandSubmission,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionSession,
  FileTransferRequest,
  FileTransferResult,
  HostKeyTrustChallenge,
  LocalTerminalConfig,
  ProfileExportDocument,
  RemoteFileEntry,
  TerminalChunk,
  TerminalSnapshot
} from '@shared/types';
import { profileExportDocumentSchema } from '@shared/validation';
import { createAppExitFlow } from '../core/app-exit-flow';
import { connectRuntime } from '../runtime/runtime-client';
import type { RuntimeRpcClient } from '../runtime/runtime-rpc';

const APP_ZOOM_FACTOR = 1.25;
const TITLE_BAR_HEIGHT = 36;
const TITLE_BAR_THEMES = {
  light: { color: '#f3f7f7', symbolColor: '#18383d', height: TITLE_BAR_HEIGHT },
  dark: { color: '#050c10', symbolColor: '#d8efeb', height: TITLE_BAR_HEIGHT },
  green: { color: '#070907', symbolColor: '#a8bea0', height: TITLE_BAR_HEIGHT }
} satisfies Record<AppTheme, { color: string; symbolColor: string; height: number }>;
app.setName('OrbitSSH');
if (process.platform === 'win32') app.setAppUserModelId('com.orbitssh.desktop');

// CI / headless hosts can lack the graphics-runtime DLLs required by Chromium's
// GPU child process. The packaged smoke test exercises startup only, so keep it
// deterministic without changing acceleration for ordinary desktop sessions.
if (process.env.ORBITSSH_PACKAGED_SMOKE_TEST === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// 兜底：捕获任何漏网的未处理异常/拒绝，记录到日志而非触发 Electron 默认的
// 「主进程 JavaScript 错误」白色弹窗。正常路径下错误应已在 RPC 客户端侧被
// reject 并内联展示到终端；这里只为防止极端情况下再弹出 JS 白框。
function reportRuntimeError(source: string, error: unknown): void {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    console.error(`[OrbitSSH][${source}] ${new Date().toISOString()}\n${message}`);
  } catch {
    // 日志通道不可用时静默，绝不向上传播导致默认弹窗
  }
}
process.on('uncaughtException', (error) => reportRuntimeError('uncaughtException', error));
process.on('unhandledRejection', (reason) => reportRuntimeError('unhandledRejection', reason));
app.on('render-process-gone', (_event, _webContents, details) => {
  reportRuntimeError('render-process-gone', new Error(`renderer exited (${details.reason}: ${details.exitCode})`));
});

let mainWindow: BrowserWindow | undefined;
let runtime: RuntimeRpcClient | undefined;
const pendingApprovalIds = new Set<string>();
const approvalOverlayIcon = nativeImage.createFromDataURL(
  `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#dc2626"/><path d="M16 8v10M16 23v1" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>').toString('base64')}`
);

function updateApprovalAttention(): void {
  const count = pendingApprovalIds.size;
  if (process.platform === 'win32') {
    mainWindow?.setOverlayIcon(count > 0 ? approvalOverlayIcon : null, count > 0 ? '有操作等待审批' : '');
    mainWindow?.flashFrame(count > 0);
  } else if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '');
  } else if (typeof app.setBadgeCount === 'function') {
    app.setBadgeCount(count);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('approval:attention', count);
  }
}

const appExitFlow = createAppExitFlow({
  hasRuntime: () => Boolean(runtime),
  choosePolicy: async () => runtime ? chooseRuntimeExitPolicy(runtime) : true,
  closeRuntime: async () => {
    await runtime?.close();
  },
  allowQuit: () => {
    runtime = undefined;
  },
  quit: () => app.quit(),
  reportError: (error) => {
    void dialog.showErrorBox('鍏抽棴 OrbitSSH 澶辫触', error instanceof Error ? error.message : String(error));
  }
});

async function syncPendingApprovalAttention(client: RuntimeRpcClient): Promise<void> {
  try {
    const sessions = await client.call<ConnectionSession[]>('sessions:list', {});
    const actions = await Promise.all(sessions.map((session) =>
      client.call<CodrivingAction[]>('codriving:events', { sessionId: session.id })
    ));
    pendingApprovalIds.clear();
    for (const action of actions.flat()) {
      if (action.status === 'pending_approval') pendingApprovalIds.add(action.id);
    }
    updateApprovalAttention();
  } catch {
    // Live action updates will still populate the attention state if the
    // initial snapshot is temporarily unavailable.
  }
}

function resolvePreloadPath(): string {
  const candidates = [path.join(__dirname, '../preload/index.mjs'), path.join(__dirname, '../preload/index.js')];
  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? candidates[0];
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1375,
    minHeight: 900,
    title: 'OrbitSSH',
    show: process.env.ORBITSSH_PACKAGED_SMOKE_TEST !== '1',
    icon: path.join(app.getAppPath(), 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#050705',
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden', titleBarOverlay: TITLE_BAR_THEMES.green }
      : {}),
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = window;
  window.on('close', appExitFlow.onWindowClose);
  window.on('focus', () => window.flashFrame(false));
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  updateApprovalAttention();
  window.webContents.setZoomFactor(APP_ZOOM_FACTOR);

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return window;
}

async function verifyPackagedRenderer(window: BrowserWindow): Promise<void> {
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('安装版渲染页面加载超时')), 10_000);
      window.webContents.once('did-finish-load', () => {
        clearTimeout(timeout);
        resolve();
      });
      window.webContents.once('did-fail-load', (_event, code, description) => {
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
  `, true) as { loaded: boolean; naturalWidth?: number; reason?: string; source?: string };

  if (!result.loaded) {
    throw new Error(`安装版品牌图标加载失败：${result.reason ?? result.source ?? '未知原因'}`);
  }
}

function registerIpc(client: RuntimeRpcClient): void {
  ipcMain.handle('appearance:title-bar-theme', (event, theme: AppTheme) => {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'green') {
      throw new Error('不支持的界面主题');
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (process.platform === 'win32' && window) window.setTitleBarOverlay(TITLE_BAR_THEMES[theme]);
  });
  ipcMain.handle('profiles:list', () => client.call<ConnectionProfile[]>('profiles:list', {}));
  ipcMain.handle('profiles:save', (_event, input: ConnectionProfileInput, id?: string) =>
    client.call<ConnectionProfile>('profiles:save', { input, id })
  );
  ipcMain.handle('profiles:delete', (_event, id: string) => client.call('profiles:delete', { profileId: id }));
  ipcMain.handle('profiles:export', async (event) => {
    if ((await client.call<ConnectionProfile[]>('profiles:list', {})).length === 0) {
      throw new Error('当前没有可导出的服务器配置');
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    const choiceOptions: Electron.MessageBoxOptions = {
      type: 'warning',
      title: '导出服务器配置',
      message: '是否在迁移文件中包含密码和私钥？',
      detail: '默认不包含敏感信息。勾选后，密码、私钥文件和私钥口令会写入导出文件；请只保存到可信位置并妥善保管。',
      buttons: ['继续导出', '取消'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: '包含密码、私钥文件和私钥口令（敏感信息）',
      checkboxChecked: false,
      noLink: true
    };
    const choice = owner
      ? await dialog.showMessageBox(owner, choiceOptions)
      : await dialog.showMessageBox(choiceOptions);
    if (choice.response === 1) return undefined;

    const document = await client.call<ProfileExportDocument>('profiles:export-document', {
      includesSecrets: choice.checkboxChecked
    });
    const date = new Date().toISOString().slice(0, 10);
    const saveOptions: Electron.SaveDialogOptions = {
      title: '导出 OrbitSSH 服务器配置',
      defaultPath: `OrbitSSH-服务器配置-${date}${document.includesSecrets ? '-含敏感信息' : ''}.json`,
      filters: [{ name: 'OrbitSSH 配置文件', extensions: ['json'] }]
    };
    const target = owner
      ? await dialog.showSaveDialog(owner, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (target.canceled || !target.filePath) return undefined;
    await writeFile(target.filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    return {
      filePath: target.filePath,
      count: document.profiles.length,
      includesSecrets: document.includesSecrets
    };
  });
  ipcMain.handle('profiles:import', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const openOptions: Electron.OpenDialogOptions = {
      title: '导入 OrbitSSH 服务器配置',
      filters: [{ name: 'OrbitSSH 配置文件', extensions: ['json'] }],
      properties: ['openFile']
    };
    const source = owner
      ? await dialog.showOpenDialog(owner, openOptions)
      : await dialog.showOpenDialog(openOptions);
    const filePath = source.filePaths[0];
    if (source.canceled || !filePath) return undefined;

    const file = await readFile(filePath);
    if (file.byteLength > 20 * 1024 * 1024) {
      throw new Error('配置文件超过 20 MB，已拒绝导入');
    }
    let document;
    try {
      document = profileExportDocumentSchema.parse(JSON.parse(file.toString('utf8')));
    } catch {
      throw new Error('配置文件格式无效或版本不受支持');
    }

    if (document.includesSecrets) {
      const warningOptions: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '导入敏感配置',
        message: '此配置文件包含密码或私钥',
        detail: '仅在你信任该文件来源时继续。密码会写入系统凭据库，私钥会复制到 OrbitSSH 的本地数据目录。',
        buttons: ['继续导入', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      };
      const warning = owner
        ? await dialog.showMessageBox(owner, warningOptions)
        : await dialog.showMessageBox(warningOptions);
      if (warning.response === 1) return undefined;
    }

    const result = await client.call<{ importedCount: number; skippedCount: number }>('profiles:import-document', {
      document
    });
    return {
      filePath,
      importedCount: result.importedCount,
      skippedCount: result.skippedCount,
      includedSecrets: document.includesSecrets
    };
  });
  ipcMain.handle('sessions:list', () => client.call<ConnectionSession[]>('sessions:list', {}));
  ipcMain.handle('approval:attention:get', async () => {
    await syncPendingApprovalAttention(client);
    return pendingApprovalIds.size;
  });
  ipcMain.handle('sessions:open', (_event, profileId: string, authorizationLevel) =>
    client.call<ConnectionSession>('sessions:open', { profileId, authorizationLevel })
  );
  ipcMain.handle('host-keys:pending', () => client.call<HostKeyTrustChallenge[]>('host-keys:pending', {}));
  ipcMain.handle('host-keys:confirm', async (_event, confirmation) => {
    try {
      await client.call('host-keys:confirm', confirmation);
    } catch {
      throw new Error('主机指纹确认失败。请重新发起连接并通过可信渠道核对指纹后重试。');
    }
  });
  ipcMain.handle('sessions:close', (_event, sessionId: string) => client.call('sessions:close', { sessionId }));
  ipcMain.handle('sessions:health', (_event, sessionId: string) =>
    client.call<ConnectionSession>('sessions:health', { sessionId })
  );
  ipcMain.handle('commands:run', async (_event, sessionId: string, command: string) => {
    const submission = await client.call<{ result?: CommandResult; action: { status: string } }>(
      'commands:request',
      { sessionId, command }
    );
    if (!submission.result) throw new Error(`命令等待用户批准：${submission.action.status}`);
    return submission.result;
  });
  ipcMain.handle('history:list', (_event, sessionId?: string) => client.call('history:list', { sessionId }));
  ipcMain.handle('files:transfer', async (_event, request: FileTransferRequest) => {
    const submission = await client.call<{ result?: FileTransferResult; action: { status: string } }>(
      'files:request',
      request
    );
    if (!submission.result) throw new Error(`文件操作等待用户批准：${submission.action.status}`);
    return submission.result;
  });
  ipcMain.handle('files:list-remote', (_event, sessionId: string, remotePath: string) =>
    client.call<RemoteFileEntry[]>('files:list-remote', { sessionId, remotePath })
  );
  ipcMain.handle('files:pick-local', async (event, defaultPath?: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: '选择要上传的文件',
      defaultPath: typeof defaultPath === 'string' && defaultPath.trim() ? defaultPath : undefined,
      properties: ['openFile', 'multiSelections']
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled
      ? []
      : result.filePaths.map((filePath) => ({ name: path.basename(filePath), path: filePath }));
  });
  ipcMain.handle('files:pick-download-target', async (event, defaultPath: string | undefined, fileName: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const safeName = path.basename(fileName) || 'download';
    const options: Electron.SaveDialogOptions = {
      title: '保存远程文件',
      defaultPath: typeof defaultPath === 'string' && defaultPath.trim()
        ? path.join(defaultPath, safeName)
        : safeName
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    return result.canceled ? undefined : result.filePath;
  });
  ipcMain.handle('terminal:open', (_event, sessionId: string) =>
    client.call<TerminalSnapshot>('terminal:open', { sessionId })
  );
  ipcMain.handle('terminal:write', (_event, sessionId: string, terminalId: string, data: string) =>
    client.call('terminal:write', { sessionId, terminalId, data })
  );
  ipcMain.handle('terminal:submit', (_event, sessionId: string, terminalId: string, command: string) =>
    client.call<CodrivingCommandSubmission>('terminal:submit', { sessionId, terminalId, command })
  );
  ipcMain.handle('terminal:close', (_event, terminalId: string) => client.call('terminal:close', { terminalId }));
  ipcMain.handle('codriving:events', (_event, sessionId: string, afterSequence?: number) =>
    client.call<CodrivingAction[]>('codriving:events', { sessionId, afterSequence })
  );
  ipcMain.handle('codriving:approve', (_event, approval: CodrivingApproval) =>
    client.call('codriving:approve', approval)
  );
  ipcMain.handle('codriving:reject', (_event, approval: CodrivingApproval) =>
    client.call<CodrivingAction>('codriving:reject', approval)
  );
  ipcMain.handle('codriving:pause', (_event, sessionId: string) => client.call('codriving:pause', { sessionId }));
  ipcMain.handle('codriving:resume', (_event, sessionId: string) => client.call('codriving:resume', { sessionId }));
  ipcMain.handle('codriving:paused', (_event, sessionId: string) =>
    client.call<boolean>('codriving:paused', { sessionId })
  );
  ipcMain.handle('codriving:set-authorization', (_event, change) =>
    client.call<ConnectionSession>('codriving:set-authorization', change)
  );
  ipcMain.handle('clipboard:read-text', () => clipboard.readText());

  // 本地终端 IPC handlers
  ipcMain.handle('local:open-session', (_event, config?: LocalTerminalConfig) =>
    client.call<ConnectionSession>('local:open-session', config)
  );
  ipcMain.handle('local:open-terminal', (_event, sessionId: string) =>
    client.call<{ terminalId: string; replay: unknown }>('local:open-terminal', { sessionId })
  );
  ipcMain.handle('local:write-terminal', (_event, terminalId: string, data: string) =>
    client.call('local:write-terminal', { terminalId, data })
  );
  ipcMain.handle('local:resize-terminal', (_event, terminalId: string, cols: number, rows: number) =>
    client.call('local:resize-terminal', { terminalId, cols, rows })
  );
  ipcMain.handle('local:close-terminal', (_event, terminalId: string) =>
    client.call('local:close-terminal', { terminalId })
  );
  ipcMain.handle('local:close-session', (_event, sessionId: string) =>
    client.call('local:close-session', { sessionId })
  );

  client.on('terminal:data', (chunk: TerminalChunk) => {
    mainWindow?.webContents.send('terminal:data', chunk);
  });
  client.on('codriving:action-updated', (action: CodrivingAction) => {
    if (action.status === 'pending_approval') pendingApprovalIds.add(action.id);
    else pendingApprovalIds.delete(action.id);
    updateApprovalAttention();
    mainWindow?.webContents.send('codriving:action-updated', action);
  });
  client.on('session:updated', (session: ConnectionSession) => {
    mainWindow?.webContents.send('session:updated', session);
  });
}

app.whenReady().then(async () => {
  runtime = await connectRuntime({ kind: 'desktop' });
  if (process.env.ORBITSSH_PACKAGED_SMOKE_TEST === '1') {
    registerIpc(runtime);
    const smokeWindow = createWindow();
    void syncPendingApprovalAttention(runtime);
    await verifyPackagedRenderer(smokeWindow);
    const screenshotPath = process.env.ORBITSSH_PACKAGED_SMOKE_SCREENSHOT;
    if (screenshotPath) {
      const screenshot = await smokeWindow.webContents.capturePage();
      await writeFile(screenshotPath, screenshot.toPNG());
    }
    await runtime.call('profiles:list', {});
    await runtime.call('runtime:set-exit-policy', { policy: 'close_all' });
    smokeWindow.destroy();
    // 冒烟测试模式下不需要优雅关闭，直接退出。
    process.exit(0);
    return;
  }
  registerIpc(runtime);
  createWindow();
  void syncPendingApprovalAttention(runtime);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(async (error: unknown) => {
  if (process.env.ORBITSSH_PACKAGED_SMOKE_TEST === '1') {
    console.error('OrbitSSH 启动失败:', error instanceof Error ? error.message : String(error));
    app.exit(1);
    return;
  }
  await dialog.showErrorBox('OrbitSSH 启动失败', error instanceof Error ? error.message : String(error));
  app.exit(1);
});

app.on('before-quit', appExitFlow.onBeforeQuit);

async function chooseRuntimeExitPolicy(client: RuntimeRpcClient): Promise<boolean> {
  const sessions = await client.call<ConnectionSession[]>('sessions:list', {});
  if (sessions.length === 0) {
    await client.call('runtime:set-exit-policy', { policy: 'close_all' });
    return true;
  }
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: '关闭 OrbitSSH',
    message: '关闭界面后，如何处理当前共驾会话？',
    detail: '选择“Codex 继续”会保留 Runtime、SSH 会话和执行队列；无界面时的高危操作不会执行，会等待重新打开客户端批准并在超时后自动拒绝。',
    buttons: ['仅关闭界面，Codex 继续', '任务完成后关闭', '立即关闭全部能力', '取消'],
    defaultId: 0,
    cancelId: 3,
    noLink: true
  };
  const choice = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (choice.response === 3) return false;
  const policies = ['keep_codex', 'finish_then_exit', 'close_all'] as const;
  await client.call('runtime:set-exit-policy', { policy: policies[choice.response] });
  return true;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
