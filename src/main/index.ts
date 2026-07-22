import { app, BrowserWindow, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ConnectionProfileInput, FileTransferRequest, TerminalChunk } from '@shared/types';
import { fileTransferSchema, hostKeyTrustConfirmationSchema, profileInputSchema } from '@shared/validation';
import { createCoreServices } from '@core/services';
import { registerElectronCleanup } from '@core/process-lifecycle';

const services = createCoreServices();
const { profileStore, historyStore, sessionManager } = services;
registerElectronCleanup(app, services.close);

let mainWindow: BrowserWindow | undefined;

function resolvePreloadPath(): string {
  const candidates = [path.join(__dirname, '../preload/index.mjs'), path.join(__dirname, '../preload/index.js')];
  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? candidates[0];
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: 'AI SSH',
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
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
  ipcMain.handle('terminal:open', (_event, sessionId: string) => sessionManager.openTerminal(sessionId));
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
