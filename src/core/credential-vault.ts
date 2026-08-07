import { AsyncEntry } from '@napi-rs/keyring';

const SERVICE = 'AI SSH';

type CredentialEntry = Pick<AsyncEntry, 'setPassword' | 'getPassword' | 'deleteCredential'>;

export class CredentialVault {
  constructor(private readonly entryFactory: (id: string) => CredentialEntry =
    (id) => new AsyncEntry(SERVICE, id)) {}

  async setSecret(id: string, value: string): Promise<void> {
    if (!value) {
      return;
    }

    await this.entryFactory(id).setPassword(value);
  }

  async getSecret(id?: string): Promise<string | undefined> {
    if (!id) {
      return undefined;
    }

    const value = await this.entryFactory(id).getPassword();
    return value ?? undefined;
  }

  async deleteSecret(id?: string): Promise<void> {
    if (!id) {
      return;
    }

    await this.entryFactory(id).deleteCredential();
  }
}

export function credentialId(profileId: string, kind: 'password' | 'private-key-passphrase'): string {
  return `${profileId}:${kind}`;
}
