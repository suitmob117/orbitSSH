import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ConnectionProfile,
  ConnectionProfileInput,
  PortableConnectionProfile,
  ProfileExportDocument
} from '../shared/types';
import type { CredentialVault } from './credential-vault';
import { resolveAppDataDir } from './paths';
import type { ProfileStore } from './profile-store';

export interface ProfileImportSummary {
  importedCount: number;
  skippedCount: number;
}

function portableProfile(profile: ConnectionProfile): PortableConnectionProfile {
  return {
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    privateKeyPath: profile.privateKeyPath,
    connectTimeoutMs: profile.connectTimeoutMs,
    keepaliveIntervalMs: profile.keepaliveIntervalMs,
    jumpHost: profile.jumpHost,
    localTransferRoot: profile.localTransferRoot,
    remoteTransferRoots: profile.remoteTransferRoots
  };
}

function profileIdentity(profile: Pick<ConnectionProfile, 'name' | 'host' | 'port' | 'username'>): string {
  return JSON.stringify([profile.name, profile.host, profile.port, profile.username]);
}

export class ProfilePortabilityService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly credentials: CredentialVault,
    private readonly dataDir = resolveAppDataDir()
  ) {}

  async createExport(includesSecrets: boolean): Promise<ProfileExportDocument> {
    const profiles = await this.profiles.list();
    const portableProfiles = await Promise.all(profiles.map(async (profile) => {
      const portable = portableProfile(profile);
      if (!includesSecrets) return portable;

      const password = await this.credentials.getSecret(profile.credentialId);
      const privateKeyPassphrase = await this.credentials.getSecret(profile.privateKeyPassphraseCredentialId);
      let privateKeyContent: string | undefined;
      let privateKeyFileName: string | undefined;
      if (profile.authMethod === 'private_key' && profile.privateKeyPath) {
        try {
          privateKeyContent = await readFile(profile.privateKeyPath, 'utf8');
          privateKeyFileName = path.basename(profile.privateKeyPath);
        } catch {
          throw new Error(`无法读取“${profile.name}”的私钥文件，已停止完整导出`);
        }
      }
      const credentials = {
        password,
        privateKeyFileName,
        privateKeyContent,
        privateKeyPassphrase
      };
      return Object.values(credentials).some(Boolean) ? { ...portable, credentials } : portable;
    }));

    return {
      format: 'orbitssh-connections',
      version: 1,
      exportedAt: new Date().toISOString(),
      includesSecrets,
      profiles: portableProfiles
    };
  }

  async importDocument(document: ProfileExportDocument): Promise<ProfileImportSummary> {
    const existing = await this.profiles.list();
    const identities = new Set(existing.map(profileIdentity));
    const importedIds: string[] = [];
    const importedKeyPaths: string[] = [];
    let skippedCount = 0;

    try {
      for (const portable of document.profiles) {
        const identity = profileIdentity(portable);
        if (identities.has(identity)) {
          skippedCount += 1;
          continue;
        }

        let privateKeyPath = portable.privateKeyPath;
        if (portable.credentials?.privateKeyContent && portable.credentials.privateKeyFileName) {
          const keyDirectory = path.join(this.dataDir, 'imported-keys');
          await mkdir(keyDirectory, { recursive: true });
          const safeName = path.basename(portable.credentials.privateKeyFileName)
            .replace(/[^A-Za-z0-9._-]/g, '_') || 'private-key';
          privateKeyPath = path.join(keyDirectory, `${randomUUID()}-${safeName}`);
          await writeFile(privateKeyPath, portable.credentials.privateKeyContent, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx'
          });
          importedKeyPaths.push(privateKeyPath);
        }

        const input: ConnectionProfileInput = {
          name: portable.name,
          host: portable.host,
          port: portable.port,
          username: portable.username,
          authMethod: portable.authMethod === 'password_prompt' ? 'saved_password' : portable.authMethod,
          password: portable.credentials?.password,
          privateKeyPath,
          privateKeyPassphrase: portable.credentials?.privateKeyPassphrase,
          rememberPrivateKeyPassphrase: Boolean(portable.credentials?.privateKeyPassphrase),
          connectTimeoutMs: portable.connectTimeoutMs,
          keepaliveIntervalMs: portable.keepaliveIntervalMs,
          jumpHost: portable.jumpHost,
          localTransferRoot: portable.localTransferRoot,
          remoteTransferRoots: portable.remoteTransferRoots
        };
        const imported = await this.profiles.importProfile(input);
        importedIds.push(imported.id);
        identities.add(identity);
      }
    } catch (error) {
      for (const id of importedIds.reverse()) {
        try {
          await this.profiles.delete(id);
        } catch {
          // 保留原始导入异常；尽最大努力回滚已导入配置。
        }
      }
      await Promise.all(importedKeyPaths.map(async (keyPath) => {
        try {
          await rm(keyPath, { force: true });
        } catch {
          // 私钥清理失败不能覆盖原始导入异常。
        }
      }));
      throw error;
    }

    return { importedCount: importedIds.length, skippedCount };
  }
}
