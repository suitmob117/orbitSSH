import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AiSshApi,
  AppTheme,
  AuthorizationLevel,
  ConnectionProfileInput,
  FileTransferRequest,
  TerminalChunk
} from '@shared/types';

const api: AiSshApi = {
  setTitleBarTheme: (theme: AppTheme) => ipcRenderer.invoke('appearance:title-bar-theme', theme),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (input: ConnectionProfileInput, id?: string) => ipcRenderer.invoke('profiles:save', input, id),
  deleteProfile: (id: string) => ipcRenderer.invoke('profiles:delete', id),
  exportProfiles: () => ipcRenderer.invoke('profiles:export'),
  importProfiles: () => ipcRenderer.invoke('profiles:import'),
  openSession: (profileId: string, authorizationLevel: AuthorizationLevel) =>
    ipcRenderer.invoke('sessions:open', profileId, authorizationLevel),
  listHostKeyTrustChallenges: () => ipcRenderer.invoke('host-keys:pending'),
  confirmHostKeyTrust: (challenge) => ipcRenderer.invoke('host-keys:confirm', challenge),
  closeSession: (sessionId: string) => ipcRenderer.invoke('sessions:close', sessionId),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSessionHealth: (sessionId: string) => ipcRenderer.invoke('sessions:health', sessionId),
  runCommand: (sessionId: string, command: string) => ipcRenderer.invoke('commands:run', sessionId, command),
  listHistory: (sessionId?: string) => ipcRenderer.invoke('history:list', sessionId),
  transferFile: (request: FileTransferRequest) => ipcRenderer.invoke('files:transfer', request),
  listRemoteDirectory: (sessionId: string, remotePath: string) =>
    ipcRenderer.invoke('files:list-remote', sessionId, remotePath),
  pickLocalFiles: (defaultPath?: string) => ipcRenderer.invoke('files:pick-local', defaultPath),
  pickDownloadTarget: (defaultPath: string | undefined, fileName: string) =>
    ipcRenderer.invoke('files:pick-download-target', defaultPath, fileName),
  getPathForDroppedFile: (file: File) => webUtils.getPathForFile(file),
  openTerminal: (sessionId: string) => ipcRenderer.invoke('terminal:open', sessionId),
  writeTerminal: (sessionId: string, terminalId: string, data: string) =>
    ipcRenderer.invoke('terminal:write', sessionId, terminalId, data),
  closeTerminal: (terminalId: string) => ipcRenderer.invoke('terminal:close', terminalId),
  onTerminalData: (callback: (chunk: TerminalChunk) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: TerminalChunk) => callback(chunk);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.off('terminal:data', listener);
  },
  listCodrivingActions: (sessionId: string, afterSequence?: number) =>
    ipcRenderer.invoke('codriving:events', sessionId, afterSequence),
  approveCodrivingAction: (approval) => ipcRenderer.invoke('codriving:approve', approval),
  rejectCodrivingAction: (approval) => ipcRenderer.invoke('codriving:reject', approval),
  pauseCodex: (sessionId: string) => ipcRenderer.invoke('codriving:pause', sessionId),
  resumeCodex: (sessionId: string) => ipcRenderer.invoke('codriving:resume', sessionId),
  isCodexPaused: (sessionId: string) => ipcRenderer.invoke('codriving:paused', sessionId),
  setSessionAuthorization: (change) => ipcRenderer.invoke('codriving:set-authorization', change),
  onCodrivingAction: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, action: Parameters<typeof callback>[0]) => callback(action);
    ipcRenderer.on('codriving:action-updated', listener);
    return () => ipcRenderer.off('codriving:action-updated', listener);
  },
  onSessionUpdated: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, session: Parameters<typeof callback>[0]) => callback(session);
    ipcRenderer.on('session:updated', listener);
    return () => ipcRenderer.off('session:updated', listener);
  }
};

contextBridge.exposeInMainWorld('aiSsh', api);
