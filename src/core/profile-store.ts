import { randomUUID } from 'node:crypto';
import type { ConnectionProfile, ConnectionProfileInput } from '../shared/types';
import { profileInputSchema } from '../shared/validation';
import { credentialId, CredentialVault } from './credential-vault';
import { JsonStore } from './json-store';

export class ProfileStore {
  private readonly store = new JsonStore<ConnectionProfile[]>('profiles.json', []);

  constructor(private readonly credentialVault: CredentialVault) {}

  async list(): Promise<ConnectionProfile[]> {
    return this.store.read();
  }

  async get(id: string): Promise<ConnectionProfile> {
    const profile = (await this.list()).find((item) => item.id === id);
    if (!profile) {
      throw new Error(`连接配置不存在：${id}`);
    }
    return profile;
  }

  async save(input: ConnectionProfileInput, id?: string): Promise<ConnectionProfile> {
    const parsed = profileInputSchema.parse(input);
    const profiles = await this.list();
    const now = new Date().toISOString();
    const existing = id ? profiles.find((item) => item.id === id) : undefined;
    const profileId = id ?? randomUUID();
    const passwordCredentialId = credentialId(profileId, 'password');
    const passphraseCredentialId = credentialId(profileId, 'private-key-passphrase');

    if (parsed.authMethod === 'saved_password') {
      if (parsed.password) {
        await this.credentialVault.setSecret(passwordCredentialId, parsed.password);
      } else if (!existing?.credentialId) {
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
      credentialId: parsed.authMethod === 'saved_password' ? passwordCredentialId : undefined,
      privateKeyPassphraseCredentialId: parsed.rememberPrivateKeyPassphrase
        ? passphraseCredentialId
        : existing?.privateKeyPassphraseCredentialId,
      connectTimeoutMs: parsed.connectTimeoutMs,
      keepaliveIntervalMs: parsed.keepaliveIntervalMs,
      jumpHost: parsed.jumpHost?.trim() || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    const next = existing
      ? profiles.map((item) => (item.id === existing.id ? profile : item))
      : [...profiles, profile];
    await this.store.write(next);
    return profile;
  }

  async delete(id: string): Promise<void> {
    const profiles = await this.list();
    const profile = profiles.find((item) => item.id === id);
    if (profile) {
      await this.credentialVault.deleteSecret(profile.credentialId);
      await this.credentialVault.deleteSecret(profile.privateKeyPassphraseCredentialId);
    }
    await this.store.write(profiles.filter((item) => item.id !== id));
  }
}
