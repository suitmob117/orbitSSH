import { CredentialVault } from './credential-vault';
import { HistoryStore } from './history-store';
import { ProfileStore } from './profile-store';
import { SqliteStore, type SqliteStorePort } from './sqlite-store';
import { SshSessionManager } from './ssh-session-manager';

export interface CoreServices {
  credentialVault: CredentialVault;
  sqliteStore: SqliteStorePort;
  profileStore: ProfileStore;
  historyStore: HistoryStore;
  sessionManager: SshSessionManager;
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
  const profileStore = new ProfileStore(credentialVault, { sqlite: sqliteStore });
  const historyStore = new HistoryStore({ sqlite: sqliteStore });
  const sessionManager = new SshSessionManager(profileStore, credentialVault, historyStore);
  let closed = false;

  return {
    credentialVault,
    sqliteStore,
    profileStore,
    historyStore,
    sessionManager,
    close: () => {
      if (closed) return;
      closed = true;
      sqliteStore.close();
    }
  };
}
