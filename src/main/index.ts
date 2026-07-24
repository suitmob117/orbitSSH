import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AppTheme,
  CommandRecord,
  CommandResult,
  CodrivingAction,
  CodrivingApproval,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionSession,
  FileTransferRequest,
  FileTransferResult,
  HostKeyTrustChallenge,
  ProfileExportDocument,
  RemoteFileEntry,
  TerminalChunk,
  TerminalSnapshot
} from '@shared/types';
import { profileExportDocumentSchema } from '@shared/validation';
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

let mainWindow: BrowserWindow | undefined;
let runtime: RuntimeRpcClient | undefined;
let quitInProgress = false;
let quitAllowed = false;

function resolvePreloadPath(): string {
  const candidates = [path.join(__dirname, '../preload/index.mjs'), path.join(__dirname, '../preload/index.js')];
  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? candidates[0];
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1375,
    minHeight: 900,
    title: 'OrbitSSH',
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
  window.webContents.setZoomFactor(APP_ZOOM_FACTOR);

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
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
    client.call<CommandRecord>('terminal:submit', { sessionId, terminalId, command })
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

  client.on('terminal:data', (chunk: TerminalChunk) => {
    mainWindow?.webContents.send('terminal:data', chunk);
  });
  client.on('codriving:action-updated', (action: CodrivingAction) => {
    mainWindow?.webContents.send('codriving:action-updated', action);
  });
  client.on('session:updated', (session: ConnectionSession) => {
    mainWindow?.webContents.send('session:updated', session);
  });
}

app.whenReady().then(async () => {
  runtime = await connectRuntime({ kind: 'desktop' });
  registerIpc(runtime);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(async (error: unknown) => {
  await dialog.showErrorBox('OrbitSSH 启动失败', error instanceof Error ? error.message : String(error));
  app.exit(1);
});

app.on('before-quit', (event) => {
  if (quitAllowed || !runtime) return;
  event.preventDefault();
  if (quitInProgress) return;
  quitInProgress = true;
  void chooseRuntimeExitPolicy(runtime).then(async (confirmed) => {
    if (!confirmed) return;
    await runtime?.close();
    runtime = undefined;
    quitAllowed = true;
    app.quit();
  }).finally(() => {
    quitInProgress = false;
  });
});

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
