import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppTheme, ConnectionProfileInput, FileTransferRequest, TerminalChunk } from '@shared/types';
import {
  fileTransferSchema,
  hostKeyTrustConfirmationSchema,
  profileExportDocumentSchema,
  profileInputSchema,
  remoteDirectoryRequestSchema
} from '@shared/validation';
import { createCoreServices } from '@core/services';
import { registerElectronCleanup } from '@core/process-lifecycle';
import { ProfilePortabilityService } from '@core/profile-portability';

const services = createCoreServices();
const APP_ZOOM_FACTOR = 1.25;
const TITLE_BAR_HEIGHT = 36;
const TITLE_BAR_THEMES = {
  light: { color: '#f3f7f7', symbolColor: '#18383d', height: TITLE_BAR_HEIGHT },
  dark: { color: '#050c10', symbolColor: '#d8efeb', height: TITLE_BAR_HEIGHT },
  green: { color: '#070907', symbolColor: '#a8bea0', height: TITLE_BAR_HEIGHT }
} satisfies Record<AppTheme, { color: string; symbolColor: string; height: number }>;
const { profileStore, credentialVault, historyStore, sessionManager } = services;
const profilePortability = new ProfilePortabilityService(profileStore, credentialVault);
registerElectronCleanup(app, services.close);
app.setName('OrbitSSH');

let mainWindow: BrowserWindow | undefined;

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

function registerIpc(): void {
  ipcMain.handle('appearance:title-bar-theme', (event, theme: AppTheme) => {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'green') {
      throw new Error('不支持的界面主题');
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (process.platform === 'win32' && window) window.setTitleBarOverlay(TITLE_BAR_THEMES[theme]);
  });
  ipcMain.handle('profiles:list', () => profileStore.list());
  ipcMain.handle('profiles:save', async (_event, input: ConnectionProfileInput, id?: string) => {
    const parsed = profileInputSchema.parse(input);
    if (id) sessionManager.assertProfileCanBeUpdated(id, parsed);
    const profile = await profileStore.save(parsed, id);
    sessionManager.discardHostKeyChallenge(profile.id);
    return profile;
  });
  ipcMain.handle('profiles:delete', async (_event, id: string) => {
    sessionManager.assertProfileCanBeDeleted(id);
    await profileStore.delete(id);
    sessionManager.discardHostKeyChallenge(id);
  });
  ipcMain.handle('profiles:export', async (event) => {
    if ((await profileStore.list()).length === 0) {
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

    const document = await profilePortability.createExport(choice.checkboxChecked);
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

    const result = await profilePortability.importDocument(document);
    return {
      filePath,
      importedCount: result.importedCount,
      skippedCount: result.skippedCount,
      includedSecrets: document.includesSecrets
    };
  });
  ipcMain.handle('sessions:list', () => sessionManager.listSessions());
  ipcMain.handle('sessions:open', (_event, profileId: string, authorizationLevel) =>
    sessionManager.openSession(profileId, authorizationLevel)
  );
  ipcMain.handle('host-keys:pending', () => sessionManager.listHostKeyTrustChallenges());
  ipcMain.handle('host-keys:confirm', async (_event, confirmation) => {
    try {
      await sessionManager.confirmHostKeyTrust(hostKeyTrustConfirmationSchema.parse(confirmation));
    } catch {
      throw new Error('主机指纹确认失败。请重新发起连接并通过可信渠道核对指纹后重试。');
    }
  });
  ipcMain.handle('sessions:close', (_event, sessionId: string) => sessionManager.closeSession(sessionId));
  ipcMain.handle('sessions:health', (_event, sessionId: string) => sessionManager.getHealth(sessionId));
  ipcMain.handle('commands:run', (_event, sessionId: string, command: string) =>
    sessionManager.runCommand(sessionId, command)
  );
  ipcMain.handle('history:list', (_event, sessionId?: string) => historyStore.list(sessionId));
  ipcMain.handle('files:transfer', (_event, request: FileTransferRequest) =>
    sessionManager.transferFile(fileTransferSchema.parse(request))
  );
  ipcMain.handle('files:list-remote', (_event, sessionId: string, remotePath: string) => {
    const request = remoteDirectoryRequestSchema.parse({ sessionId, remotePath });
    return sessionManager.listRemoteDirectory(request.sessionId, request.remotePath);
  });
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
  ipcMain.handle('terminal:open', (_event, sessionId: string) => sessionManager.openTerminal(sessionId));
  ipcMain.handle('terminal:command', (_event, sessionId: string, terminalId: string, command: string) =>
    sessionManager.runTerminalCommand(sessionId, terminalId, command)
  );
  ipcMain.handle('terminal:write', (_event, terminalId: string, data: string) =>
    sessionManager.writeTerminal(terminalId, data)
  );
  ipcMain.handle('terminal:close', (_event, terminalId: string) => sessionManager.closeTerminal(terminalId));

  sessionManager.on('terminal-data', (chunk: TerminalChunk) => {
    mainWindow?.webContents.send('terminal:data', chunk);
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
