import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { z } from 'zod';
import type { CommandRecord, ConnectionProfile, TrustedHostKey } from '../shared/types';
import { commandRecordSchema, connectionProfileSchema, trustedHostKeySchema } from '../shared/validation';
import { resolveAppDataDir, resolveSqliteDatabasePath } from './paths';

export type MigrationStatus = {
  usingJsonFallback: boolean;
  unavailable: boolean;
  migrationBlocked: boolean;
  reason?: string;
};

export interface SqliteStoreOptions {
  backupOperations?: Partial<{
    copyFile(source: string, destination: string): void;
    chmod(file: string, mode: number): void;
  }>;
}

/**
 * 配置与历史存储的最小接口。业务层依赖这个接口，测试可以安全替换，
 * 而不会因为 SQLite 暂时不可用而悄悄写回旧 JSON。
 */
export interface SqliteStorePort {
  readonly status: MigrationStatus;
  listProfiles(): ConnectionProfile[];
  saveProfile(profile: ConnectionProfile): ConnectionProfile;
  deleteProfile(id: string): void;
  listHistory(): CommandRecord[];
  appendHistory(record: CommandRecord): CommandRecord;
  getHostKey(profileId: string): TrustedHostKey | undefined;
  saveHostKey(hostKey: TrustedHostKey): TrustedHostKey;
  close(): void;
}

type LegacyData = {
  profiles: ConnectionProfile[];
  history: CommandRecord[];
  profileFile?: string;
  historyFile?: string;
  profileHash?: string;
  historyHash?: string;
};

type ImportedState = {
  profileHash?: string;
  historyHash?: string;
};

const LEGACY_MIGRATION_KEY = 'legacy-json-migration-v1';
const IMPORTED_PREFIX = 'imported:';
const BUSY_RETRIES = 4;
const BUSY_TIMEOUT_MS = 300;

const require = createRequire(import.meta.url);

/**
 * Node/MCP 与 Electron 需要各自 ABI 对应的 SQLite 原生绑定，不能共享重建产物。
 */
export function resolveSqliteDriverModuleName(
  runtime: Pick<NodeJS.ProcessVersions, 'electron'> = process.versions
): 'better-sqlite3' | 'better-sqlite3-electron' {
  return runtime.electron ? 'better-sqlite3-electron' : 'better-sqlite3';
}

const Database = require(resolveSqliteDriverModuleName()) as typeof BetterSqlite3;

export class SqliteStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteStoreUnavailableError';
  }
}

class SafeJsonFallbackError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : '旧 JSON 迁移失败');
    this.name = 'SafeJsonFallbackError';
  }
}

export class SqliteStore implements SqliteStorePort {
  private readonly dataDir: string;
  private readonly databasePath: string;
  private database?: BetterSqlite3.Database;
  private readonly backupOperations: Required<NonNullable<SqliteStoreOptions['backupOperations']>>;
  readonly status: MigrationStatus = { usingJsonFallback: false, unavailable: false, migrationBlocked: false };

  constructor(dataDir = resolveAppDataDir(), options: SqliteStoreOptions = {}) {
    this.dataDir = dataDir;
    this.backupOperations = {
      copyFile: options.backupOperations?.copyFile ?? ((source, destination) =>
        copyFileSync(source, destination, constants.COPYFILE_EXCL)),
      chmod: options.backupOperations?.chmod ?? chmodSync
    };
    mkdirSync(dataDir, { recursive: true });
    this.databasePath = resolveSqliteDatabasePath(dataDir);

    try {
      this.database = new Database(this.databasePath, { timeout: BUSY_TIMEOUT_MS });
      this.configureDatabase();
      this.createSchema();
      this.migrateLegacyJson(dataDir);
    } catch (error) {
      this.applyInitializationFailure(error);
      this.close();
    }
  }

  listProfiles(): ConnectionProfile[] {
    return this.runDatabase(() => this.requireDatabase().prepare(`
      SELECT id, name, host, port, username, auth_method, private_key_path, credential_id,
        private_key_passphrase_credential_id, connect_timeout_ms, keepalive_interval_ms,
        jump_host, local_transfer_root, remote_transfer_roots, created_at, updated_at
      FROM profiles ORDER BY rowid
    `).all().map((row) => this.toProfile(row as Record<string, unknown>)));
  }

  listHistory(): CommandRecord[] {
    return this.runDatabase(() => this.requireDatabase().prepare(`
      SELECT id, session_id, command, started_at, finished_at, exit_code, signal,
        stdout_tail, stderr_tail, summary
      FROM command_history ORDER BY rowid
    `).all().map((row) => this.toHistory(row as Record<string, unknown>)));
  }

  saveProfile(profile: ConnectionProfile): ConnectionProfile {
    const validated = connectionProfileSchema.parse(profile);
    this.assertWritable();
    return this.runDatabase(() => {
      const db = this.requireDatabase();
      const save = db.transaction(() => {
        const existing = db.prepare('SELECT host, port FROM profiles WHERE id = ?').get(validated.id) as
          | { host: string; port: number }
          | undefined;
        if (existing && (existing.host !== validated.host || existing.port !== validated.port)) {
          db.prepare('DELETE FROM host_keys WHERE profile_id = ?').run(validated.id);
        }
        db.prepare(`
        INSERT INTO profiles (
          id, name, host, port, username, auth_method, private_key_path, credential_id,
          private_key_passphrase_credential_id, connect_timeout_ms, keepalive_interval_ms,
          jump_host, local_transfer_root, remote_transfer_roots, created_at, updated_at
        ) VALUES (
          @id, @name, @host, @port, @username, @authMethod, @privateKeyPath, @credentialId,
          @privateKeyPassphraseCredentialId, @connectTimeoutMs, @keepaliveIntervalMs,
          @jumpHost, @localTransferRoot, @remoteTransferRoots, @createdAt, @updatedAt
        ) ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          host = excluded.host,
          port = excluded.port,
          username = excluded.username,
          auth_method = excluded.auth_method,
          private_key_path = excluded.private_key_path,
          credential_id = excluded.credential_id,
          private_key_passphrase_credential_id = excluded.private_key_passphrase_credential_id,
          connect_timeout_ms = excluded.connect_timeout_ms,
          keepalive_interval_ms = excluded.keepalive_interval_ms,
          jump_host = excluded.jump_host,
          local_transfer_root = excluded.local_transfer_root,
          remote_transfer_roots = excluded.remote_transfer_roots,
          updated_at = excluded.updated_at
        `).run(this.profileParameters(validated));
      });
      save();
      return validated;
    });
  }

  deleteProfile(id: string): void {
    this.assertWritable();
    this.runDatabase(() => {
      const db = this.requireDatabase();
      db.transaction(() => {
        db.prepare('DELETE FROM host_keys WHERE profile_id = ?').run(id);
        db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      })();
    });
  }

  appendHistory(record: CommandRecord): CommandRecord {
    const validated = commandRecordSchema.parse(record);
    this.assertWritable();
    return this.runDatabase(() => {
      const db = this.requireDatabase();
      db.transaction(() => {
        db.prepare(`
          INSERT INTO command_history (
            id, session_id, command, started_at, finished_at, exit_code, signal,
            stdout_tail, stderr_tail, summary
          ) VALUES (
            @id, @sessionId, @command, @startedAt, @finishedAt, @exitCode, @signal,
            @stdoutTail, @stderrTail, @summary
          )
        `).run(this.historyParameters(validated));
        db.prepare(`
          DELETE FROM command_history
          WHERE id IN (
            SELECT id FROM command_history
            ORDER BY rowid DESC
            LIMIT -1 OFFSET 500
          )
        `).run();
      })();
      return validated;
    });
  }

  getHostKey(profileId: string): TrustedHostKey | undefined {
    return this.runDatabase(() => {
      const row = this.requireDatabase().prepare(`
        SELECT profile_id, host, port, fingerprint, trusted_at, updated_at
        FROM host_keys WHERE profile_id = ?
      `).get(profileId) as Record<string, unknown> | undefined;
      return row ? this.toHostKey(row) : undefined;
    });
  }

  saveHostKey(hostKey: TrustedHostKey): TrustedHostKey {
    const validated = trustedHostKeySchema.parse(hostKey);
    this.assertWritable();
    return this.runDatabase(() => {
      this.requireDatabase().prepare(`
        INSERT INTO host_keys (profile_id, host, port, fingerprint, trusted_at, updated_at)
        VALUES (@profileId, @host, @port, @fingerprint, @trustedAt, @updatedAt)
        ON CONFLICT(profile_id) DO UPDATE SET
          host = excluded.host,
          port = excluded.port,
          fingerprint = excluded.fingerprint,
          updated_at = excluded.updated_at
      `).run(validated);
      return validated;
    });
  }

  journalMode(): string {
    return this.runDatabase(() => String(this.requireDatabase().pragma('journal_mode', { simple: true })).toLowerCase());
  }

  hasSchema(table: 'profiles' | 'command_history' | 'host_keys'): boolean {
    return this.runDatabase(() => Boolean(this.requireDatabase().prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table)));
  }

  assertWritable(): void {
    this.requireDatabase();
    if (this.status.migrationBlocked) {
      throw new Error(this.status.reason ?? '迁移安全检查未完成，已阻止数据库写入');
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private createSchema(): void {
    this.requireDatabase().exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        private_key_path TEXT,
        credential_id TEXT,
        private_key_passphrase_credential_id TEXT,
        connect_timeout_ms INTEGER NOT NULL,
        keepalive_interval_ms INTEGER NOT NULL,
        jump_host TEXT,
        local_transfer_root TEXT,
        remote_transfer_roots TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_history (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        command TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        stdout_tail TEXT NOT NULL,
        stderr_tail TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_keys (
        profile_id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        trusted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migration_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.ensureProfileTransferColumns();
  }

  private ensureProfileTransferColumns(): void {
    const columns = this.requireDatabase().prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('local_transfer_root')) {
      this.requireDatabase().exec('ALTER TABLE profiles ADD COLUMN local_transfer_root TEXT');
    }
    if (!names.has('remote_transfer_roots')) {
      this.requireDatabase().exec("ALTER TABLE profiles ADD COLUMN remote_transfer_roots TEXT NOT NULL DEFAULT '[]'");
    }
  }

  private configureDatabase(): void {
    this.withBusyRetry(() => this.requireDatabase().pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`));
    this.withBusyRetry(() => this.requireDatabase().pragma('journal_mode = WAL'));
    this.withBusyRetry(() => this.requireDatabase().pragma('foreign_keys = ON'));
  }

  private migrateLegacyJson(dataDir: string): void {
    const observedState = this.getMigrationState();
    if (observedState === 'complete') return;
    const observedBusinessData = this.hasBusinessData();

    let preparedLegacy: LegacyData;
    try {
      preparedLegacy = this.readLegacyJson(dataDir);
    } catch (error) {
      this.blockMigration(error instanceof Error ? error.message : '旧 JSON 校验失败，已阻止迁移');
      return;
    }
    try {
      this.backupLegacyFiles(preparedLegacy, observedState === undefined && !observedBusinessData);
    } catch (error) {
      this.handlePreMigrationFailure(error);
      return;
    }

    try {
      const migrate = this.requireDatabase().transaction(() => {
        const state = this.getMigrationState();
        if (state === 'complete') return;

        const legacy = this.readLegacyJson(dataDir);
        if (!this.matchesLegacySnapshot(preparedLegacy, legacy)) {
          this.blockMigration('旧 JSON 在备份后发生变化，已阻止数据库写入');
          return;
        }

        if (state?.startsWith(IMPORTED_PREFIX)) {
          const imported = this.decodeImportedState(state);
          if (!imported || !this.matchesImportedState(imported, legacy)) {
            this.blockMigration('旧 JSON 源文件已变化或迁移状态不完整，已阻止数据库写入');
            return;
          }
          try {
            this.verifyImport(legacy);
          } catch (error) {
            this.blockMigration(error instanceof Error ? error.message : '已导入数据校验失败，已阻止数据库写入');
            return;
          }
          this.setMigrationState('complete');
          return;
        }
        if (state !== undefined) {
          this.blockMigration('检测到未知的数据迁移状态，已保护现有数据库数据');
          return;
        }
        if (this.hasBusinessData()) {
          this.blockMigration('数据库已有业务数据但没有迁移状态，已阻止覆盖或删除');
          return;
        }
        if (legacy.profileFile || legacy.historyFile) {
          this.importLegacyRecords(legacy);
          this.verifyImport(legacy);
        }
        this.setMigrationState('complete');
      });
      this.withBusyRetry(() => migrate.immediate());
    } catch (error) {
      if (this.isBusyError(error)) throw error;
      if (this.status.migrationBlocked) return;
      throw new SafeJsonFallbackError(error);
    }
  }

  private importLegacyRecords(legacy: LegacyData): void {
    const db = this.requireDatabase();
    const insertProfile = db.prepare(`
      INSERT INTO profiles (
        id, name, host, port, username, auth_method, private_key_path, credential_id,
        private_key_passphrase_credential_id, connect_timeout_ms, keepalive_interval_ms,
        jump_host, local_transfer_root, remote_transfer_roots, created_at, updated_at
      ) VALUES (
        @id, @name, @host, @port, @username, @authMethod, @privateKeyPath, @credentialId,
        @privateKeyPassphraseCredentialId, @connectTimeoutMs, @keepaliveIntervalMs,
        @jumpHost, @localTransferRoot, @remoteTransferRoots, @createdAt, @updatedAt
      )
    `);
    const insertHistory = db.prepare(`
      INSERT INTO command_history (
        id, session_id, command, started_at, finished_at, exit_code, signal,
        stdout_tail, stderr_tail, summary
      ) VALUES (
        @id, @sessionId, @command, @startedAt, @finishedAt, @exitCode, @signal,
        @stdoutTail, @stderrTail, @summary
      )
    `);
    for (const profile of legacy.profiles) insertProfile.run(this.profileParameters(profile));
    for (const record of legacy.history) insertHistory.run(this.historyParameters(record));
  }

  private readLegacyJson(dataDir: string): LegacyData {
    const profiles = this.readLegacyArray(path.join(dataDir, 'profiles.json'), connectionProfileSchema);
    const history = this.readLegacyArray(path.join(dataDir, 'history.json'), commandRecordSchema);
    return {
      profiles: profiles.records,
      history: history.records,
      profileFile: profiles.file,
      historyFile: history.file,
      profileHash: profiles.hash,
      historyHash: history.hash
    };
  }

  private readLegacyArray<T>(file: string, schema: z.ZodType<T>): { records: T[]; file?: string; hash?: string } {
    if (!existsSync(file)) return { records: [] };
    const source = readFileSync(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.toString('utf8'));
    } catch (error) {
      throw new Error(`无法读取旧数据文件 ${path.basename(file)}：${error instanceof Error ? error.message : '格式错误'}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`无法读取旧数据文件 ${path.basename(file)}：根节点必须是数组`);
    }
    return {
      records: parsed.map((item, index) => {
        const result = schema.safeParse(item);
        if (!result.success) {
          throw new Error(`旧数据文件 ${path.basename(file)} 第 ${index + 1} 条记录校验失败：${result.error.message}`);
        }
        return result.data;
      }),
      file,
      hash: createHash('sha256').update(source).digest('hex')
    };
  }

  private verifyImport(legacy: LegacyData): void {
    const importedProfiles = this.listProfiles();
    const importedHistory = this.listHistory();
    if (JSON.stringify(importedProfiles) !== JSON.stringify(legacy.profiles) ||
      JSON.stringify(importedHistory) !== JSON.stringify(legacy.history)) {
      throw new Error('旧数据导入后的全字段校验失败');
    }
  }

  private backupLegacyFiles(legacy: LegacyData, allowSourceMismatch = false): void {
    for (const file of [legacy.profileFile, legacy.historyFile]) {
      if (!file) continue;
      const backup = `${file}.bak`;
      this.withFileBusyRetry(() => {
        const source = readFileSync(file);
        if (!existsSync(backup)) {
          try {
            this.backupOperations.copyFile(file, backup);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
        const sourceUnchanged = source.equals(readFileSync(file));
        const backupMatches = source.equals(readFileSync(backup));
        if (!sourceUnchanged || (!backupMatches && !allowSourceMismatch)) {
          throw new Error(`旧数据备份与源文件不一致，拒绝迁移：${path.basename(backup)}`);
        }
        this.backupOperations.chmod(backup, 0o444);
      });
    }
  }

  private handlePreMigrationFailure(error: unknown): void {
    const reason = error instanceof Error ? error.message : '旧 JSON 读取或备份失败';
    const classify = this.requireDatabase().transaction(() => {
      const state = this.getMigrationState();
      if (state === 'complete') return 'complete' as const;
      if (state !== undefined || this.hasBusinessData()) return 'blocked' as const;
      return 'fallback' as const;
    });
    const outcome = this.withBusyRetry(() => classify.immediate());
    if (outcome === 'complete') return;
    if (outcome === 'fallback') throw new SafeJsonFallbackError(error);
    this.blockMigration(reason);
  }

  private decodeImportedState(state: string): ImportedState | undefined {
    try {
      const value = JSON.parse(state.slice(IMPORTED_PREFIX.length)) as unknown;
      if (!value || typeof value !== 'object') return undefined;
      const candidate = value as ImportedState;
      if ((candidate.profileHash !== undefined && typeof candidate.profileHash !== 'string') ||
        (candidate.historyHash !== undefined && typeof candidate.historyHash !== 'string')) return undefined;
      return candidate;
    } catch {
      return undefined;
    }
  }

  private matchesImportedState(imported: ImportedState, legacy: LegacyData): boolean {
    return imported.profileHash === legacy.profileHash && imported.historyHash === legacy.historyHash;
  }

  private matchesLegacySnapshot(expected: LegacyData, actual: LegacyData): boolean {
    return expected.profileFile === actual.profileFile &&
      expected.historyFile === actual.historyFile &&
      expected.profileHash === actual.profileHash &&
      expected.historyHash === actual.historyHash;
  }

  private hasBusinessData(): boolean {
    const db = this.requireDatabase();
    const profiles = db.prepare('SELECT EXISTS(SELECT 1 FROM profiles LIMIT 1) AS has_data').get() as { has_data: number };
    const history = db.prepare('SELECT EXISTS(SELECT 1 FROM command_history LIMIT 1) AS has_data').get() as { has_data: number };
    const hostKeys = db.prepare('SELECT EXISTS(SELECT 1 FROM host_keys LIMIT 1) AS has_data').get() as { has_data: number };
    if (profiles.has_data === 1 || history.has_data === 1 || hostKeys.has_data === 1) return true;

    const externalTables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT IN ('migration_state', 'profiles', 'command_history', 'host_keys')
    `).all() as Array<{ name: string }>;
    return externalTables.some(({ name }) => {
      const identifier = `"${name.replaceAll('"', '""')}"`;
      const result = db.prepare(`SELECT EXISTS(SELECT 1 FROM ${identifier} LIMIT 1) AS has_data`).get() as { has_data: number };
      return result.has_data === 1;
    });
  }

  private blockMigration(reason: string): void {
    this.status.migrationBlocked = true;
    this.status.reason = reason;
  }

  private getMigrationState(): string | undefined {
    return (this.requireDatabase().prepare('SELECT value FROM migration_state WHERE key = ?').get(LEGACY_MIGRATION_KEY) as
      | { value: string }
      | undefined)?.value;
  }

  private setMigrationState(value: string): void {
    this.requireDatabase().prepare(
      `INSERT INTO migration_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(LEGACY_MIGRATION_KEY, value);
  }

  private requireDatabase(): BetterSqlite3.Database {
    if (this.database) return this.database;
    if (this.status.unavailable) {
      this.recoverUnavailableDatabase();
      if (this.database) return this.database;
      throw new SqliteStoreUnavailableError(this.status.reason ?? 'SQLite 数据库暂不可用，未回退到 JSON');
    }
    throw new Error(this.status.reason ?? 'SQLite 数据库不可用，当前使用 JSON 回退');
  }

  private recoverUnavailableDatabase(): void {
    try {
      this.database = new Database(this.databasePath, { timeout: BUSY_TIMEOUT_MS });
      this.configureDatabase();
      this.createSchema();
      this.status.migrationBlocked = false;
      this.migrateLegacyJson(this.dataDir);
      this.status.unavailable = false;
      this.status.usingJsonFallback = false;
      if (!this.status.migrationBlocked) this.status.reason = undefined;
    } catch (error) {
      this.applyInitializationFailure(error);
      this.close();
    }
  }

  private applyInitializationFailure(error: unknown): void {
    const safeFallback = error instanceof SafeJsonFallbackError;
    const busy = this.isBusyError(error);
    this.status.usingJsonFallback = safeFallback;
    this.status.unavailable = busy;
    this.status.migrationBlocked = !safeFallback && !busy;
    this.status.reason = error instanceof Error ? error.message : 'SQLite 初始化失败';
  }

  private runDatabase<T>(operation: () => T): T {
    try {
      // A temporarily unavailable store gets one controlled reopen attempt per public operation.
      // Retrying that reopen inside every busy retry would multiply the lock wait window.
      this.requireDatabase();
      return this.withBusyRetry(operation);
    } catch (error) {
      if (this.isBusyError(error)) {
        this.status.unavailable = true;
        this.status.usingJsonFallback = false;
        this.status.reason = error instanceof Error ? error.message : 'SQLite 数据库被锁定';
        this.close();
        throw new SqliteStoreUnavailableError(this.status.reason);
      }
      throw error;
    }
  }

  private withBusyRetry<T>(operation: () => T): T {
    let lastError: unknown;
    for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        lastError = error;
        if (!this.isBusyError(error) || attempt === BUSY_RETRIES - 1) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private withFileBusyRetry<T>(operation: () => T): T {
    let lastError: unknown;
    for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'EBUSY' && code !== 'EPERM') || attempt === BUSY_RETRIES - 1) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private isBusyError(error: unknown): boolean {
    return error instanceof Error && /database(?: table)? is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message);
  }

  private toProfile(row: Record<string, unknown>): ConnectionProfile {
    const profile: Record<string, unknown> = {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      authMethod: row.auth_method,
      connectTimeoutMs: row.connect_timeout_ms,
      keepaliveIntervalMs: row.keepalive_interval_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    this.assignOptional(profile, 'privateKeyPath', row.private_key_path);
    this.assignOptional(profile, 'credentialId', row.credential_id);
    this.assignOptional(profile, 'privateKeyPassphraseCredentialId', row.private_key_passphrase_credential_id);
    this.assignOptional(profile, 'jumpHost', row.jump_host);
    this.assignOptional(profile, 'localTransferRoot', row.local_transfer_root);
    const remoteTransferRoots = this.parseRemoteTransferRoots(row.remote_transfer_roots);
    if (remoteTransferRoots) profile.remoteTransferRoots = remoteTransferRoots;
    return connectionProfileSchema.parse(profile);
  }

  private toHistory(row: Record<string, unknown>): CommandRecord {
    const record: Record<string, unknown> = {
      id: row.id,
      sessionId: row.session_id,
      command: row.command,
      startedAt: row.started_at,
      stdoutTail: row.stdout_tail,
      stderrTail: row.stderr_tail,
      summary: row.summary
    };
    this.assignOptional(record, 'finishedAt', row.finished_at);
    if (typeof row.exit_code === 'number') record.exitCode = row.exit_code;
    this.assignOptional(record, 'signal', row.signal);
    return commandRecordSchema.parse(record);
  }

  private toHostKey(row: Record<string, unknown>): TrustedHostKey {
    return trustedHostKeySchema.parse({
      profileId: row.profile_id,
      host: row.host,
      port: row.port,
      fingerprint: row.fingerprint,
      trustedAt: row.trusted_at,
      updatedAt: row.updated_at
    });
  }

  private assignOptional(target: Record<string, unknown>, key: string, value: unknown): void {
    if (typeof value === 'string') target[key] = value;
  }

  private parseRemoteTransferRoots(value: unknown): string[] | undefined {
    if (typeof value !== 'string') return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') && parsed.length > 0
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  private profileParameters(profile: ConnectionProfile): Record<string, string | number | null> {
    return {
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod,
      privateKeyPath: profile.privateKeyPath ?? null,
      credentialId: profile.credentialId ?? null,
      privateKeyPassphraseCredentialId: profile.privateKeyPassphraseCredentialId ?? null,
      connectTimeoutMs: profile.connectTimeoutMs,
      keepaliveIntervalMs: profile.keepaliveIntervalMs,
      jumpHost: profile.jumpHost ?? null,
      localTransferRoot: profile.localTransferRoot ?? null,
      remoteTransferRoots: JSON.stringify(profile.remoteTransferRoots ?? []),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    };
  }

  private historyParameters(record: CommandRecord): Record<string, string | number | null> {
    return {
      id: record.id,
      sessionId: record.sessionId,
      command: record.command,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? null,
      exitCode: record.exitCode ?? null,
      signal: record.signal ?? null,
      stdoutTail: record.stdoutTail,
      stderrTail: record.stderrTail,
      summary: record.summary
    };
  }
}
