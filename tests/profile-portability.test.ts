import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CredentialVault } from '../src/core/credential-vault';
import { ProfilePortabilityService } from '../src/core/profile-portability';
import { ProfileStore } from '../src/core/profile-store';
import type { SqliteStorePort } from '../src/core/sqlite-store';
import { profileExportDocumentSchema } from '../src/shared/validation';
import type { ConnectionProfile } from '../src/shared/types';

const portableProfile = {
  name: '生产服务器',
  host: '203.0.113.10',
  port: 22,
  username: 'root',
  authMethod: 'saved_password' as const,
  connectTimeoutMs: 15_000,
  keepaliveIntervalMs: 15_000,
  localTransferRoot: 'C:\\Users\\tester\\Downloads',
  remoteTransferRoots: ['/srv/app']
};

function memoryVault(): CredentialVault {
  const secrets = new Map<string, string>();
  return new CredentialVault((id) => ({
    setPassword: async (value: string) => {
      secrets.set(id, value);
    },
    getPassword: async () => secrets.get(id) ?? null,
    deleteCredential: async () => secrets.delete(id)
  }));
}

function memoryProfileStore(vault: CredentialVault): ProfileStore {
  let records: ConnectionProfile[] = [];
  const sqlite = {
    status: { usingJsonFallback: true, unavailable: false, migrationBlocked: false }
  } as unknown as SqliteStorePort;
  return new ProfileStore(vault, {
    sqlite,
    jsonStore: {
      read: async () => records,
      write: async (next) => {
        records = next;
      }
    }
  });
}

test('迁移文件可选择携带凭据，但格式不接受游离的敏感字段', () => {
  const safe = profileExportDocumentSchema.parse({
    format: 'orbitssh-connections',
    version: 1,
    exportedAt: '2026-07-23T00:00:00.000Z',
    includesSecrets: false,
    profiles: [portableProfile]
  });
  assert.equal(safe.profiles[0]?.credentials, undefined);

  const full = profileExportDocumentSchema.parse({
    ...safe,
    includesSecrets: true,
    profiles: [
      { ...portableProfile, credentials: { password: 'secret' } },
      {
        ...portableProfile,
        name: '私钥服务器',
        authMethod: 'private_key',
        privateKeyPath: 'C:\\Keys\\id_ed25519',
        credentials: {
        privateKeyFileName: 'id_ed25519',
        privateKeyContent: '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----',
        privateKeyPassphrase: 'key-secret'
        }
      }
    ]
  });
  assert.equal(full.profiles[0]?.credentials?.password, 'secret');

  assert.throws(() => profileExportDocumentSchema.parse({
    ...safe,
    profiles: [{ ...portableProfile, password: 'unexpected-plaintext-secret' }]
  }));
});

test('无密码迁移的保存密码配置可导入，但再次保存时必须补录密码', async () => {
  const vault = {
    getSecret: async () => undefined,
    setSecret: async () => undefined,
    deleteSecret: async () => undefined
  } as unknown as CredentialVault;
  const store = memoryProfileStore(vault);

  const imported = await store.importProfile(portableProfile);

  assert.equal(imported.authMethod, 'saved_password');
  assert.equal(imported.credentialId, undefined);
  await assert.rejects(store.save(portableProfile, imported.id), /需要输入密码/);
});

test('完整导出和导入会迁移密码、私钥文件与私钥口令，并跳过重复配置', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'orbitssh-export-'));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), 'orbitssh-import-'));
  try {
    const sourceVault = memoryVault();
    const sourceStore = memoryProfileStore(sourceVault);
    const keyPath = path.join(sourceDir, 'id_ed25519');
    const keyContent = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key\n-----END OPENSSH PRIVATE KEY-----\n';
    await writeFile(keyPath, keyContent, 'utf8');
    await sourceStore.save({ ...portableProfile, password: 'server-password' });
    await sourceStore.save({
      ...portableProfile,
      name: '私钥服务器',
      host: '203.0.113.11',
      authMethod: 'private_key',
      privateKeyPath: keyPath,
      privateKeyPassphrase: 'key-passphrase',
      rememberPrivateKeyPassphrase: true
    });

    const sourceService = new ProfilePortabilityService(sourceStore, sourceVault, sourceDir);
    const safeDocument = await sourceService.createExport(false);
    assert.equal(JSON.stringify(safeDocument).includes('server-password'), false);
    assert.equal(JSON.stringify(safeDocument).includes(keyContent), false);

    const document = profileExportDocumentSchema.parse(await sourceService.createExport(true));
    const targetVault = memoryVault();
    const targetStore = memoryProfileStore(targetVault);
    const targetService = new ProfilePortabilityService(targetStore, targetVault, targetDir);

    assert.deepEqual(await targetService.importDocument(document), { importedCount: 2, skippedCount: 0 });
    const imported = await targetStore.list();
    const passwordProfile = imported.find((profile) => profile.authMethod === 'saved_password');
    const keyProfile = imported.find((profile) => profile.authMethod === 'private_key');
    assert.equal(await targetVault.getSecret(passwordProfile?.credentialId), 'server-password');
    assert.equal(await targetVault.getSecret(keyProfile?.privateKeyPassphraseCredentialId), 'key-passphrase');
    assert.equal(await readFile(keyProfile?.privateKeyPath ?? '', 'utf8'), keyContent);
    assert.equal(keyProfile?.privateKeyPath?.startsWith(path.join(targetDir, 'imported-keys')), true);

    assert.deepEqual(await targetService.importDocument(document), { importedCount: 0, skippedCount: 2 });
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});
