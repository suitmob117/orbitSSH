import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiSshApi,
  AuthorizationLevel,
  ConnectionProfileInput,
  FileTransferRequest,
  TerminalChunk
} from '@shared/types';

const api: AiSshApi = {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (input: ConnectionProfileInput, id?: string) => ipcRenderer.invoke('profiles:save', input, id),
  deleteProfile: (id: string) => ipcRenderer.invoke('profiles:delete', id),
  openSession: (profileId: string, authorizationLevel: AuthorizationLevel) =>
    ipcRenderer.invoke('sessions:open', profileId, authorizationLevel),
  closeSession: (sessionId: string) => ipcRenderer.invoke('sessions:close', sessionId),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSessionHealth: (sessionId: string) => ipcRenderer.invoke('sessions:health', sessionId),
  runCommand: (sessionId: string, command: string) => ipcRenderer.invoke('commands:run', sessionId, command),
  listHistory: (sessionId?: string) => ipcRenderer.invoke('history:list', sessionId),
  transferFile: (request: FileTransferRequest) => ipcRenderer.invoke('files:transfer', request),
  openTerminal: (sessionId: string) => ipcRenderer.invoke('terminal:open', sessionId),
  writeTerminal: (terminalId: string, data: string) => ipcRenderer.invoke('terminal:write', terminalId, data),
  closeTerminal: (terminalId: string) => ipcRenderer.invoke('terminal:close', terminalId),
  onTerminalData: (callback: (chunk: TerminalChunk) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: TerminalChunk) => callback(chunk);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.off('terminal:data', listener);
  }
};

contextBridge.exposeInMainWorld('aiSsh', api);
