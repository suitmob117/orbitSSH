import { AsyncEntry } from '@napi-rs/keyring';

const SERVICE = 'AI SSH';

export class CredentialVault {
  async setSecret(id: string, value: string): Promise<void> {
    if (!value) {
      return;
    }

    await new AsyncEntry(SERVICE, id).setPassword(value);
  }

  async getSecret(id?: string): Promise<string | undefined> {
    if (!id) {
      return undefined;
    }

    const value = await new AsyncEntry(SERVICE, id).getPassword();
    return value ?? undefined;
  }

  async deleteSecret(id?: string): Promise<void> {
    if (!id) {
      return;
    }

    try {
      await new AsyncEntry(SERVICE, id).deleteCredential();
    } catch {
      // Missing credentials are already in the desired state.
    }
  }
}

export function credentialId(profileId: string, kind: 'password' | 'private-key-passphrase'): string {
  return `${profileId}:${kind}`;
}
