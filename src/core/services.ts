import { CredentialVault } from './credential-vault';
import { HistoryStore } from './history-store';
import { ProfileStore } from './profile-store';
import { SshSessionManager } from './ssh-session-manager';

export interface CoreServices {
  credentialVault: CredentialVault;
  profileStore: ProfileStore;
  historyStore: HistoryStore;
  sessionManager: SshSessionManager;
}

export function createCoreServices(): CoreServices {
  const credentialVault = new CredentialVault();
  const profileStore = new ProfileStore(credentialVault);
  const historyStore = new HistoryStore();
  const sessionManager = new SshSessionManager(profileStore, credentialVault, historyStore);

  return {
    credentialVault,
    profileStore,
    historyStore,
    sessionManager
  };
}
