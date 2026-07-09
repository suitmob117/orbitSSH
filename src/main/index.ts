import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import type { ConnectionProfileInput, FileTransferRequest, TerminalChunk } from '@shared/types';
import { fileTransferSchema, profileInputSchema } from '@shared/validation';
import { createCoreServices } from '@core/services';

const { profileStore, historyStore, sessionManager } = createCoreServices();

let mainWindow: BrowserWindow | undefined;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: 'AI SSH',
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
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
  ipcMain.handle('profiles:save', (_event, input: ConnectionProfileInput, id?: string) =>
    profileStore.save(profileInputSchema.parse(input), id)
  );
  ipcMain.handle('profiles:delete', (_event, id: string) => profileStore.delete(id));
  ipcMain.handle('sessions:list', () => sessionManager.listSessions());
  ipcMain.handle('sessions:open', (_event, profileId: string, authorizationLevel) =>
    sessionManager.openSession(profileId, authorizationLevel)
  );
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
