export type AuthMethod = 'saved_password' | 'password_prompt' | 'ssh_agent' | 'private_key';

export type AuthorizationLevel = 'ask_every_time' | 'auto_readonly' | 'trusted_session';

export type SessionHealth = 'connected' | 'degraded' | 'disconnected';

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

export interface TerminalChunk {
  sessionId: string;
  terminalId: string;
  data: string;
}

export interface AppStateSnapshot {
  profiles: ConnectionProfile[];
  sessions: ConnectionSession[];
  history: CommandRecord[];
}

export interface AiSshApi {
  listProfiles(): Promise<ConnectionProfile[]>;
  saveProfile(input: ConnectionProfileInput, id?: string): Promise<ConnectionProfile>;
  deleteProfile(id: string): Promise<void>;
  openSession(profileId: string, authorizationLevel: AuthorizationLevel): Promise<ConnectionSession>;
  listHostKeyTrustChallenges(): Promise<HostKeyTrustChallenge[]>;
  confirmHostKeyTrust(confirmation: HostKeyTrustConfirmation): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(): Promise<ConnectionSession[]>;
  getSessionHealth(sessionId: string): Promise<ConnectionSession>;
  runCommand(sessionId: string, command: string): Promise<CommandResult>;
  listHistory(sessionId?: string): Promise<CommandRecord[]>;
  transferFile(request: FileTransferRequest): Promise<FileTransferResult>;
  openTerminal(sessionId: string): Promise<string>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
  onTerminalData(callback: (chunk: TerminalChunk) => void): () => void;
}
