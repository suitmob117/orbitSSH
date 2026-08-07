import { contextBridge, ipcRenderer, webUtils } from "electron";
const api = {
  setTitleBarTheme: (theme) => ipcRenderer.invoke("appearance:title-bar-theme", theme),
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  saveProfile: (input, id) => ipcRenderer.invoke("profiles:save", input, id),
  deleteProfile: (id) => ipcRenderer.invoke("profiles:delete", id),
  exportProfiles: () => ipcRenderer.invoke("profiles:export"),
  importProfiles: () => ipcRenderer.invoke("profiles:import"),
  openSession: (profileId, authorizationLevel) => ipcRenderer.invoke("sessions:open", profileId, authorizationLevel),
  listHostKeyTrustChallenges: () => ipcRenderer.invoke("host-keys:pending"),
  confirmHostKeyTrust: (challenge) => ipcRenderer.invoke("host-keys:confirm", challenge),
  closeSession: (sessionId) => ipcRenderer.invoke("sessions:close", sessionId),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  getSessionHealth: (sessionId) => ipcRenderer.invoke("sessions:health", sessionId),
  runCommand: (sessionId, command) => ipcRenderer.invoke("commands:run", sessionId, command),
  listHistory: (sessionId) => ipcRenderer.invoke("history:list", sessionId),
  transferFile: (request) => ipcRenderer.invoke("files:transfer", request),
  listRemoteDirectory: (sessionId, remotePath) => ipcRenderer.invoke("files:list-remote", sessionId, remotePath),
  pickLocalFiles: (defaultPath) => ipcRenderer.invoke("files:pick-local", defaultPath),
  pickDownloadTarget: (defaultPath, fileName) => ipcRenderer.invoke("files:pick-download-target", defaultPath, fileName),
  getPathForDroppedFile: (file) => webUtils.getPathForFile(file),
  openTerminal: (sessionId) => ipcRenderer.invoke("terminal:open", sessionId),
  writeTerminal: (sessionId, terminalId, data) => ipcRenderer.invoke("terminal:write", sessionId, terminalId, data),
  submitTerminalCommand: (sessionId, terminalId, command) => ipcRenderer.invoke("terminal:submit", sessionId, terminalId, command),
  closeTerminal: (terminalId) => ipcRenderer.invoke("terminal:close", terminalId),
  onTerminalData: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.off("terminal:data", listener);
  },
  listCodrivingActions: (sessionId, afterSequence) => ipcRenderer.invoke("codriving:events", sessionId, afterSequence),
  approveCodrivingAction: (approval) => ipcRenderer.invoke("codriving:approve", approval),
  rejectCodrivingAction: (approval) => ipcRenderer.invoke("codriving:reject", approval),
  pauseCodex: (sessionId) => ipcRenderer.invoke("codriving:pause", sessionId),
  resumeCodex: (sessionId) => ipcRenderer.invoke("codriving:resume", sessionId),
  isCodexPaused: (sessionId) => ipcRenderer.invoke("codriving:paused", sessionId),
  setSessionAuthorization: (change) => ipcRenderer.invoke("codriving:set-authorization", change),
  onCodrivingAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("codriving:action-updated", listener);
    return () => ipcRenderer.off("codriving:action-updated", listener);
  },
  onSessionUpdated: (callback) => {
    const listener = (_event, session) => callback(session);
    ipcRenderer.on("session:updated", listener);
    return () => ipcRenderer.off("session:updated", listener);
  }
};
contextBridge.exposeInMainWorld("aiSsh", api);
