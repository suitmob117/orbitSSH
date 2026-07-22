import type { HostKeyTrustChallenge, TrustedHostKey } from '../shared/types';
import { hostKeyTrustChallengeSchema } from '../shared/validation';
import type { SqliteStorePort } from './sqlite-store';

/** SSH 主机身份信任只存储 SHA-256 指纹；SQLite 不可安全读写时由调用方拒绝连接。 */
export interface HostKeyStorePort {
  get(profileId: string): TrustedHostKey | undefined;
  confirm(challenge: HostKeyTrustChallenge): TrustedHostKey;
}

export class HostKeyStore implements HostKeyStorePort {
  constructor(private readonly sqlite: SqliteStorePort) {}

  get(profileId: string): TrustedHostKey | undefined {
    return this.sqlite.getHostKey(profileId);
  }

  confirm(challenge: HostKeyTrustChallenge): TrustedHostKey {
    const validated = hostKeyTrustChallengeSchema.parse(challenge);
    const existing = this.sqlite.getHostKey(validated.profileId);
    if (validated.risk === 'first_seen' && existing) {
      throw new Error('主机指纹已存在，拒绝覆盖首次信任记录');
    }
    if (validated.risk === 'changed' &&
      (!existing || existing.host !== validated.host || existing.port !== validated.port ||
        existing.fingerprint !== validated.oldFingerprint)) {
      throw new Error('主机指纹确认信息已过期，请重新连接并核对指纹');
    }
    const now = new Date().toISOString();
    return this.sqlite.saveHostKey({
      profileId: validated.profileId,
      host: validated.host,
      port: validated.port,
      fingerprint: validated.newFingerprint,
      trustedAt: existing?.trustedAt ?? now,
      updatedAt: now
    });
  }
}
