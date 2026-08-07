import { randomUUID } from 'node:crypto';
import type { ConnectionProfile, ConnectionProfileInput } from '../shared/types';
import { profileInputSchema } from '../shared/validation';
import { credentialId, CredentialVault } from './credential-vault';
import { JsonStore } from './json-store';
import { SqliteStore, type SqliteStorePort } from './sqlite-store';

export interface AsyncStore<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
}

export interface ProfileStoreOptions {
  sqlite?: SqliteStorePort;
  jsonStore?: AsyncStore<ConnectionProfile[]>;
}

export class ProfileStore {
  private readonly sqlite: SqliteStorePort;
  private readonly store: AsyncStore<ConnectionProfile[]>;

  constructor(private readonly credentialVault: CredentialVault, options: ProfileStoreOptions = {}) {
    this.sqlite = options.sqlite ?? new SqliteStore();
    this.store = options.jsonStore ?? new JsonStore<ConnectionProfile[]>('profiles.json', []);
  }

  async list(): Promise<ConnectionProfile[]> {
    return this.usingJsonFallback() ? this.store.read() : this.sqlite.listProfiles();
  }

  async get(id: string): Promise<ConnectionProfile> {
    const profile = (await this.list()).find((item) => item.id === id);
    if (!profile) {
      throw new Error(`连接配置不存在：${id}`);
    }
    return profile;
  }

  async save(input: ConnectionProfileInput, id?: string): Promise<ConnectionProfile> {
    return this.saveWithOptions(input, id, false);
  }

  /** 导入时允许先建立不含密码的配置，用户再次编辑保存时仍必须补录密码。 */
  async importProfile(input: ConnectionProfileInput): Promise<ConnectionProfile> {
    return this.saveWithOptions(input, undefined, true);
  }

  private async saveWithOptions(
    input: ConnectionProfileInput,
    id: string | undefined,
    allowMissingSavedPassword: boolean
  ): Promise<ConnectionProfile> {
    const parsed = profileInputSchema.parse(input);
    const profiles = await this.list();
    const now = new Date().toISOString();
    const existing = id ? profiles.find((item) => item.id === id) : undefined;
    const profileId = id ?? randomUUID();
    const remoteTransferRoots = parsed.remoteTransferRoots?.map((root) => root.trim()).filter(Boolean);
    const passwordCredentialId = credentialId(profileId, 'password');
    const passphraseCredentialId = credentialId(profileId, 'private-key-passphrase');

    const credentialIds = new Set([
      existing?.credentialId,
      existing?.privateKeyPassphraseCredentialId,
      parsed.authMethod === 'saved_password' ? passwordCredentialId : undefined,
      parsed.rememberPrivateKeyPassphrase ? passphraseCredentialId : undefined
    ].filter((value): value is string => Boolean(value)));
    const originalSecrets = new Map<string, string | undefined>();
    for (const credential of credentialIds) {
      originalSecrets.set(credential, await this.credentialVault.getSecret(credential));
    }

    try {
      if (parsed.authMethod === 'saved_password') {
        if (parsed.password) {
          await this.credentialVault.setSecret(passwordCredentialId, parsed.password);
        } else if (!existing?.credentialId && !allowMissingSavedPassword) {
          throw new Error('保存密码认证方式需要输入密码');
        }
      } else {
        await this.credentialVault.deleteSecret(existing?.credentialId);
      }

      if (parsed.rememberPrivateKeyPassphrase && parsed.privateKeyPassphrase) {
        await this.credentialVault.setSecret(passphraseCredentialId, parsed.privateKeyPassphrase);
      } else if (!parsed.rememberPrivateKeyPassphrase) {
        await this.credentialVault.deleteSecret(existing?.privateKeyPassphraseCredentialId);
      }

      const profile: ConnectionProfile = {
        id: profileId,
        name: parsed.name,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        authMethod: parsed.authMethod,
        privateKeyPath: parsed.privateKeyPath?.trim() || undefined,
        credentialId: parsed.authMethod === 'saved_password' && (parsed.password || existing?.credentialId)
          ? passwordCredentialId
          : undefined,
        privateKeyPassphraseCredentialId: parsed.rememberPrivateKeyPassphrase
          ? passphraseCredentialId
          : undefined,
        connectTimeoutMs: parsed.connectTimeoutMs,
        keepaliveIntervalMs: parsed.keepaliveIntervalMs,
        jumpHost: parsed.jumpHost?.trim() || undefined,
        localTransferRoot: parsed.localTransferRoot?.trim() || undefined,
        remoteTransferRoots: remoteTransferRoots?.length ? remoteTransferRoots : undefined,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };

      if (this.usingJsonFallback()) {
        const next = existing
          ? profiles.map((item) => (item.id === existing.id ? profile : item))
          : [...profiles, profile];
        await this.store.write(next);
      } else {
        this.sqlite.saveProfile(profile);
      }
      return profile;
    } catch (error) {
      await this.restoreCredentials(originalSecrets);
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const profiles = await this.list();
    const profile = profiles.find((item) => item.id === id);
    if (this.usingJsonFallback()) {
      await this.store.write(profiles.filter((item) => item.id !== id));
    } else {
      this.sqlite.deleteProfile(id);
    }
    if (profile) {
      await this.credentialVault.deleteSecret(profile.credentialId);
      await this.credentialVault.deleteSecret(profile.privateKeyPassphraseCredentialId);
    }
  }

  private async restoreCredentials(secrets: ReadonlyMap<string, string | undefined>): Promise<void> {
    for (const [id, value] of secrets) {
      if (value === undefined) {
        await this.credentialVault.deleteSecret(id);
      } else {
        await this.credentialVault.setSecret(id, value);
      }
    }
  }

  private usingJsonFallback(): boolean {
    return this.sqlite.status.usingJsonFallback;
  }
}
