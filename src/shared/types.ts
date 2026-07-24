export type AuthMethod = 'saved_password' | 'password_prompt' | 'ssh_agent' | 'private_key';

export type AuthorizationLevel = 'ask_every_time' | 'auto_readonly' | 'trusted_session';

export type CodrivingActor = 'user' | 'codex' | 'system';
export type CodrivingActionStatus =
  | 'pending_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'interrupted'
  | 'paused';
export type CodrivingRisk = 'readonly' | 'write' | 'high';

export interface CodrivingAction {
  id: string;
  sequence: number;
  digest: string;
  sessionId: string;
  actor: CodrivingActor;
  kind: 'command' | 'file_transfer' | 'control';
  status: CodrivingActionStatus;
  risk: CodrivingRisk;
  summary: string;
  reason: string;
  approvalExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodrivingCommandSubmission {
  action: CodrivingAction;
  result?: CommandResult;
}

export interface CodrivingFileTransferSubmission {
  action: CodrivingAction;
  result?: FileTransferResult;
}

export interface CodrivingApproval {
  actionId: string;
  digest: string;
}

export interface SessionAuthorizationChange {
  sessionId: string;
  authorizationLevel: AuthorizationLevel;
  trustedUntil?: string;
}

export interface CodrivingSessionState {
  sessionId: string;
  authorizationLevel: AuthorizationLevel;
  trustedUntil?: string;
  codexPaused: boolean;
  updatedAt: string;
}

export type RuntimeLeaseKind = 'desktop' | 'mcp' | 'active_action' | 'retained_session';

export interface RuntimeLeaseRecord {
  kind: RuntimeLeaseKind;
  id: string;
  updatedAt: string;
}

export type SessionHealth = 'connected' | 'degraded' | 'disconnected';

export type AppTheme = 'light' | 'dark' | 'green';

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;
  credentialId?: string;
  privateKeyPassphraseCredentialId?: string;
  connectTimeoutMs: number;
  keepaliveIntervalMs: number;
  jumpHost?: string;
  localTransferRoot?: string;
  remoteTransferRoots?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionProfileInput {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  rememberPrivateKeyPassphrase?: boolean;
  connectTimeoutMs: number;
  keepaliveIntervalMs: number;
  jumpHost?: string;
  localTransferRoot?: string;
  remoteTransferRoots?: string[];
}

export interface ConnectionSession {
  id: string;
  profileId: string;
  profileName: string;
  health: SessionHealth;
  authorizationLevel: AuthorizationLevel;
  openedAt: string;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface TrustedHostKey {
  profileId: string;
  host: string;
  port: number;
  fingerprint: string;
  trustedAt: string;
  updatedAt: string;
}

export interface HostKeyTrustChallenge {
  challengeId: string;
  profileId: string;
  host: string;
  port: number;
  oldFingerprint?: string;
  newFingerprint: string;
  risk: 'first_seen' | 'changed';
}

export interface HostKeyTrustConfirmation {
  profileId: string;
  challengeId: string;
}

export interface CommandRecord {
  id: string;
  sessionId: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: string;
  stdoutTail: string;
  stderrTail: string;
  summary: string;
}

export interface CommandResult {
  record: CommandRecord;
  stdout: string;
  stderr: string;
}

export interface FileTransferRequest {
  sessionId: string;
  localPath: string;
  remotePath: string;
  direction: 'upload' | 'download';
}

export interface FileTransferResult {
  id: string;
  direction: 'upload' | 'download';
  localPath: string;
  remotePath: string;
  startedAt: string;
  finishedAt: string;
}

export type RemoteFileType = 'directory' | 'file' | 'symlink' | 'other';

export interface RemoteFileEntry {
  name: string;
  path: string;
  type: RemoteFileType;
  size: number;
  modifiedAt?: string;
}

export interface LocalFileSelection {
  name: string;
  path: string;
}

export interface PortableProfileCredentials {
  password?: string;
  privateKeyFileName?: string;
  privateKeyContent?: string;
  privateKeyPassphrase?: string;
}

export interface PortableConnectionProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;
  connectTimeoutMs: number;
  keepaliveIntervalMs: number;
  jumpHost?: string;
  localTransferRoot?: string;
  remoteTransferRoots?: string[];
  credentials?: PortableProfileCredentials;
}

export interface ProfileExportDocument {
  format: 'orbitssh-connections';
  version: 1;
  exportedAt: string;
  includesSecrets: boolean;
  profiles: PortableConnectionProfile[];
}

export interface ProfileExportResult {
  filePath: string;
  count: number;
  includesSecrets: boolean;
}

export interface ProfileImportResult {
  filePath: string;
  importedCount: number;
  skippedCount: number;
  includedSecrets: boolean;
}

export interface TerminalChunk {
  sessionId: string;
  terminalId: string;
  data: string;
}

export interface TerminalSnapshot {
  terminalId: string;
  replay: string;
}

export interface AppStateSnapshot {
  profiles: ConnectionProfile[];
  sessions: ConnectionSession[];
  history: CommandRecord[];
}

export interface AiSshApi {
  setTitleBarTheme(theme: AppTheme): Promise<void>;
  listProfiles(): Promise<ConnectionProfile[]>;
  saveProfile(input: ConnectionProfileInput, id?: string): Promise<ConnectionProfile>;
  deleteProfile(id: string): Promise<void>;
  exportProfiles(): Promise<ProfileExportResult | undefined>;
  importProfiles(): Promise<ProfileImportResult | undefined>;
  openSession(profileId: string, authorizationLevel: AuthorizationLevel): Promise<ConnectionSession>;
  listHostKeyTrustChallenges(): Promise<HostKeyTrustChallenge[]>;
  confirmHostKeyTrust(confirmation: HostKeyTrustConfirmation): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(): Promise<ConnectionSession[]>;
  getSessionHealth(sessionId: string): Promise<ConnectionSession>;
  runCommand(sessionId: string, command: string): Promise<CommandResult>;
  listHistory(sessionId?: string): Promise<CommandRecord[]>;
  transferFile(request: FileTransferRequest): Promise<FileTransferResult>;
  listRemoteDirectory(sessionId: string, remotePath: string): Promise<RemoteFileEntry[]>;
  pickLocalFiles(defaultPath?: string): Promise<LocalFileSelection[]>;
  pickDownloadTarget(defaultPath: string | undefined, fileName: string): Promise<string | undefined>;
  getPathForDroppedFile(file: File): string;
  openTerminal(sessionId: string): Promise<TerminalSnapshot>;
  writeTerminal(sessionId: string, terminalId: string, data: string): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
  onTerminalData(callback: (chunk: TerminalChunk) => void): () => void;
  listCodrivingActions(sessionId: string, afterSequence?: number): Promise<CodrivingAction[]>;
  approveCodrivingAction(
    approval: CodrivingApproval
  ): Promise<CodrivingCommandSubmission | CodrivingFileTransferSubmission>;
  rejectCodrivingAction(approval: CodrivingApproval): Promise<CodrivingAction>;
  pauseCodex(sessionId: string): Promise<void>;
  resumeCodex(sessionId: string): Promise<void>;
  isCodexPaused(sessionId: string): Promise<boolean>;
  setSessionAuthorization(change: SessionAuthorizationChange): Promise<ConnectionSession>;
  onCodrivingAction(callback: (action: CodrivingAction) => void): () => void;
  onSessionUpdated(callback: (session: ConnectionSession) => void): () => void;
}
