import { CredentialVault } from './credential-vault';
import type { CodrivingLedger } from './codriving-ledger';
import { HistoryStore } from './history-store';
import { HostKeyStore } from './host-key-store';
import { LocalSessionManager } from './local-session-manager';
import { ProfileStore } from './profile-store';
import { SqliteStore, type SqliteStorePort } from './sqlite-store';
import { SshSessionManager } from './ssh-session-manager';

export interface CoreServices {
  credentialVault: CredentialVault;
  sqliteStore: SqliteStorePort;
  codrivingLedger?: CodrivingLedger;
  profileStore: ProfileStore;
  historyStore: HistoryStore;
  hostKeyStore: HostKeyStore;
  sessionManager: SshSessionManager;
  localSessionManager: LocalSessionManager;
  close(): void;
}

export interface CoreServicesOptions {
  credentialVault?: CredentialVault;
  sqliteStore?: SqliteStorePort;
}

export function createCoreServices(options: CoreServicesOptions = {}): CoreServices {
  const credentialVault = options.credentialVault ?? new CredentialVault();
  // 桌面主进程与 MCP 都经由这里构造服务；必须共用同一个 SQLite 状态，
  // 避免一个存储迁移失败、另一个仍向 JSON 写入的分叉。
  const sqliteStore = options.sqliteStore ?? new SqliteStore();
  const codrivingLedger = isCodrivingLedger(sqliteStore) &&
    !sqliteStore.status.usingJsonFallback &&
    !sqliteStore.status.unavailable &&
    !sqliteStore.status.migrationBlocked
    ? sqliteStore
    : undefined;
  const profileStore = new ProfileStore(credentialVault, { sqlite: sqliteStore });
  const historyStore = new HistoryStore({ sqlite: sqliteStore });
  const hostKeyStore = new HostKeyStore(sqliteStore);
  const sessionManager = new SshSessionManager(profileStore, credentialVault, historyStore, hostKeyStore);
  const localSessionManager = new LocalSessionManager();
  let closed = false;

  return {
    credentialVault,
    sqliteStore,
    codrivingLedger,
    profileStore,
    historyStore,
    hostKeyStore,
    sessionManager,
    localSessionManager,
    close: () => {
      if (closed) return;
      closed = true;
      localSessionManager.close();
      sqliteStore.close();
    }
  };
}

function isCodrivingLedger(value: SqliteStorePort): value is SqliteStorePort & CodrivingLedger {
  const candidate = value as Partial<CodrivingLedger>;
  return typeof candidate.loadCodrivingState === 'function' &&
    typeof candidate.recordCodrivingAction === 'function' &&
    typeof candidate.saveCodrivingSessionState === 'function' &&
    typeof candidate.replaceRuntimeLeases === 'function';
}
