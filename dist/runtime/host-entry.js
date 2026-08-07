// src/core/credential-vault.ts
import { AsyncEntry } from "@napi-rs/keyring";
var SERVICE = "AI SSH";
var CredentialVault = class {
  constructor(entryFactory = (id) => new AsyncEntry(SERVICE, id)) {
    this.entryFactory = entryFactory;
  }
  entryFactory;
  async setSecret(id, value) {
    if (!value) {
      return;
    }
    await this.entryFactory(id).setPassword(value);
  }
  async getSecret(id) {
    if (!id) {
      return void 0;
    }
    const value = await this.entryFactory(id).getPassword();
    return value ?? void 0;
  }
  async deleteSecret(id) {
    if (!id) {
      return;
    }
    await this.entryFactory(id).deleteCredential();
  }
};
function credentialId(profileId, kind) {
  return `${profileId}:${kind}`;
}

// src/core/history-store.ts
import { randomUUID } from "crypto";

// src/core/json-store.ts
import { readFile, rename, writeFile } from "fs/promises";
import path2 from "path";

// src/core/paths.ts
import { mkdir } from "fs/promises";
import os from "os";
import path from "path";
function resolveAppDataDir() {
  if (process.env.AI_SSH_DATA_DIR) {
    return process.env.AI_SSH_DATA_DIR;
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "AI SSH");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AI SSH");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "ai-ssh");
}
var SQLITE_DATABASE_FILE = "ai-ssh.sqlite";
function resolveSqliteDatabasePath(dataDir = resolveAppDataDir()) {
  return path.join(dataDir, SQLITE_DATABASE_FILE);
}
async function ensureAppDataDir() {
  const dir = resolveAppDataDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

// src/core/json-store.ts
var JsonStore = class {
  constructor(fileName, fallback) {
    this.fileName = fileName;
    this.fallback = fallback;
  }
  fileName;
  fallback;
  async read() {
    const dir = await ensureAppDataDir();
    const file = path2.join(dir, this.fileName);
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return this.fallback;
      }
      throw error;
    }
  }
  async write(value) {
    const dir = await ensureAppDataDir();
    const file = path2.join(dir, this.fileName);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}
`, "utf8");
    await rename(temp, file);
  }
};

// src/core/sqlite-store.ts
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { createRequire } from "module";
import path3 from "path";

// src/shared/validation.ts
import { z } from "zod";
var optionalTrimmedString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? void 0 : value,
  z.string().trim().min(1).optional()
);
var optionalTrimmedStringArray = z.preprocess(
  (value) => Array.isArray(value) ? value.map((item) => typeof item === "string" ? item.trim() : item).filter((item) => item !== "") : value,
  z.array(z.string().trim().min(1)).optional()
);
var connectionProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  authMethod: z.enum(["saved_password", "password_prompt", "ssh_agent", "private_key"]),
  privateKeyPath: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(),
  privateKeyPassphraseCredentialId: z.string().min(1).optional(),
  connectTimeoutMs: z.number().int().min(1e3).max(12e4),
  keepaliveIntervalMs: z.number().int().min(5e3).max(3e5),
  jumpHost: z.string().min(1).optional(),
  localTransferRoot: z.string().trim().min(1).optional(),
  remoteTransferRoots: z.array(z.string().trim().min(1)).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
var commandRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  command: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  exitCode: z.number().int().optional(),
  signal: z.string().min(1).optional(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  summary: z.string()
});
var authorizationLevelSchema = z.enum(["ask_every_time", "auto_readonly", "trusted_session"]);
var codrivingActionSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().min(1),
  actor: z.enum(["user", "codex", "system"]),
  kind: z.enum(["command", "file_transfer", "control"]),
  status: z.enum([
    "pending_approval",
    "queued",
    "running",
    "completed",
    "failed",
    "rejected",
    "expired",
    "interrupted",
    "paused"
  ]),
  risk: z.enum(["readonly", "write", "high"]),
  summary: z.string(),
  reason: z.string(),
  approvalExpiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
var codrivingSessionStateSchema = z.object({
  sessionId: z.string().min(1),
  authorizationLevel: authorizationLevelSchema,
  trustedUntil: z.string().datetime().optional(),
  codexPaused: z.boolean(),
  updatedAt: z.string().datetime()
});
var runtimeLeaseRecordSchema = z.object({
  kind: z.enum(["desktop", "mcp", "active_action", "retained_session"]),
  id: z.string().min(1),
  updatedAt: z.string().datetime()
});
var codrivingApprovalSchema = z.object({
  actionId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
});
var sessionAuthorizationChangeSchema = z.object({
  sessionId: z.string().min(1),
  authorizationLevel: authorizationLevelSchema,
  trustedUntil: z.string().datetime().optional()
}).superRefine((change, context) => {
  if (change.authorizationLevel === "trusted_session" && !change.trustedUntil) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "\u4FE1\u4EFB\u4F1A\u8BDD\u5FC5\u987B\u8BBE\u7F6E\u6709\u6548\u671F",
      path: ["trustedUntil"]
    });
  }
});
var hostKeyTrustChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  profileId: z.string().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  oldFingerprint: z.string().min(1).optional(),
  newFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
  risk: z.enum(["first_seen", "changed"])
});
var hostKeyTrustConfirmationSchema = z.object({
  profileId: z.string().min(1),
  challengeId: z.string().uuid()
});
var trustedHostKeySchema = hostKeyTrustChallengeSchema.pick({
  profileId: true,
  host: true,
  port: true
}).extend({
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
  trustedAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
var profileInputSchema = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  authMethod: z.enum(["saved_password", "password_prompt", "ssh_agent", "private_key"]),
  password: z.string().optional(),
  privateKeyPath: optionalTrimmedString,
  privateKeyPassphrase: z.string().optional(),
  rememberPrivateKeyPassphrase: z.boolean().optional(),
  connectTimeoutMs: z.number().int().min(1e3).max(12e4),
  keepaliveIntervalMs: z.number().int().min(5e3).max(3e5),
  jumpHost: optionalTrimmedString,
  localTransferRoot: optionalTrimmedString,
  remoteTransferRoots: optionalTrimmedStringArray
});
var fileTransferSchema = z.object({
  sessionId: z.string().min(1),
  localPath: z.string().min(1),
  remotePath: z.string().min(1),
  direction: z.enum(["upload", "download"])
});
var remoteDirectoryRequestSchema = z.object({
  sessionId: z.string().min(1),
  remotePath: z.string().min(1)
});
var portableProfileCredentialsSchema = z.object({
  password: z.string().min(1).max(4096).optional(),
  privateKeyFileName: z.string().min(1).max(255).optional(),
  privateKeyContent: z.string().min(1).max(2e6).optional(),
  privateKeyPassphrase: z.string().min(1).max(4096).optional()
}).strict().refine(
  (credentials) => Boolean(credentials.privateKeyFileName) === Boolean(credentials.privateKeyContent),
  { message: "\u79C1\u94A5\u6587\u4EF6\u540D\u548C\u5185\u5BB9\u5FC5\u987B\u540C\u65F6\u63D0\u4F9B" }
);
var portableConnectionProfileSchema = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  authMethod: z.enum(["saved_password", "password_prompt", "ssh_agent", "private_key"]),
  privateKeyPath: optionalTrimmedString,
  connectTimeoutMs: z.number().int().min(1e3).max(12e4),
  keepaliveIntervalMs: z.number().int().min(5e3).max(3e5),
  jumpHost: optionalTrimmedString,
  localTransferRoot: optionalTrimmedString,
  remoteTransferRoots: optionalTrimmedStringArray,
  credentials: portableProfileCredentialsSchema.optional()
}).strict().superRefine((profile, context) => {
  if (profile.credentials?.password && profile.authMethod !== "saved_password") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "\u5BC6\u7801\u53EA\u80FD\u7528\u4E8E\u4FDD\u5B58\u5BC6\u7801\u8BA4\u8BC1\u914D\u7F6E",
      path: ["credentials", "password"]
    });
  }
  const hasPrivateKeySecret = Boolean(
    profile.credentials?.privateKeyContent || profile.credentials?.privateKeyPassphrase
  );
  if (hasPrivateKeySecret && profile.authMethod !== "private_key") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "\u79C1\u94A5\u51ED\u636E\u53EA\u80FD\u7528\u4E8E\u79C1\u94A5\u8BA4\u8BC1\u914D\u7F6E",
      path: ["credentials"]
    });
  }
});
var profileExportDocumentSchema = z.object({
  format: z.literal("orbitssh-connections"),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  includesSecrets: z.boolean(),
  profiles: z.array(portableConnectionProfileSchema).max(1e3)
}).strict().superRefine((document, context) => {
  if (!document.includesSecrets && document.profiles.some((profile) => profile.credentials)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "\u5B89\u5168\u5BFC\u51FA\u6587\u4EF6\u4E0D\u80FD\u5305\u542B\u51ED\u636E",
      path: ["profiles"]
    });
  }
});

// src/core/sqlite-store.ts
var LEGACY_MIGRATION_KEY = "legacy-json-migration-v1";
var IMPORTED_PREFIX = "imported:";
var BUSY_RETRIES = 4;
var BUSY_TIMEOUT_MS = 300;
var require2 = createRequire(import.meta.url);
function resolveSqliteDriverModuleName(runtime = process.versions) {
  return runtime.electron ? "better-sqlite3-electron" : "better-sqlite3";
}
var Database = require2(resolveSqliteDriverModuleName());
var SqliteStoreUnavailableError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SqliteStoreUnavailableError";
  }
};
var SafeJsonFallbackError = class extends Error {
  constructor(error) {
    super(error instanceof Error ? error.message : "\u65E7 JSON \u8FC1\u79FB\u5931\u8D25");
    this.name = "SafeJsonFallbackError";
  }
};
var SqliteStore = class {
  dataDir;
  databasePath;
  database;
  backupOperations;
  status = { usingJsonFallback: false, unavailable: false, migrationBlocked: false };
  constructor(dataDir = resolveAppDataDir(), options = {}) {
    this.dataDir = dataDir;
    this.backupOperations = {
      copyFile: options.backupOperations?.copyFile ?? ((source, destination) => copyFileSync(source, destination, constants.COPYFILE_EXCL)),
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
  listProfiles() {
    return this.runDatabase(() => this.requireDatabase().prepare(`
      SELECT id, name, host, port, username, auth_method, private_key_path, credential_id,
        private_key_passphrase_credential_id, connect_timeout_ms, keepalive_interval_ms,
        jump_host, local_transfer_root, remote_transfer_roots, created_at, updated_at
      FROM profiles ORDER BY rowid
    `).all().map((row) => this.toProfile(row)));
  }
  listHistory() {
    return this.runDatabase(() => this.requireDatabase().prepare(`
      SELECT id, session_id, command, started_at, finished_at, exit_code, signal,
        stdout_tail, stderr_tail, summary
      FROM command_history ORDER BY rowid
    `).all().map((row) => this.toHistory(row)));
  }
  saveProfile(profile) {
    const validated = connectionProfileSchema.parse(profile);
    this.assertWritable();
    return this.runDatabase(() => {
      const db = this.requireDatabase();
      const save = db.transaction(() => {
        const existing = db.prepare("SELECT host, port FROM profiles WHERE id = ?").get(validated.id);
        if (existing && (existing.host !== validated.host || existing.port !== validated.port)) {
          db.prepare("DELETE FROM host_keys WHERE profile_id = ?").run(validated.id);
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
  deleteProfile(id) {
    this.assertWritable();
    this.runDatabase(() => {
      const db = this.requireDatabase();
      db.transaction(() => {
        db.prepare("DELETE FROM host_keys WHERE profile_id = ?").run(id);
        db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
      })();
    });
  }
  appendHistory(record) {
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
  getHostKey(profileId) {
    return this.runDatabase(() => {
      const row = this.requireDatabase().prepare(`
        SELECT profile_id, host, port, fingerprint, trusted_at, updated_at
        FROM host_keys WHERE profile_id = ?
      `).get(profileId);
      return row ? this.toHostKey(row) : void 0;
    });
  }
  saveHostKey(hostKey) {
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
  loadCodrivingState() {
    return this.runDatabase(() => {
      const db = this.requireDatabase();
      const actions = db.prepare(`
        SELECT action_id, sequence, digest, session_id, actor, kind, status, risk,
          summary, reason, approval_expires_at, created_at, updated_at
        FROM session_events ORDER BY sequence
      `).all().map((row) => this.toCodrivingAction(row));
      const sessions = db.prepare(`
        SELECT session_id, authorization_level, trusted_until, codex_paused, updated_at
        FROM codriving_session_state ORDER BY rowid
      `).all().map((row) => this.toCodrivingSessionState(row));
      return { actions, sessions };
    });
  }
  recordCodrivingAction(action) {
    const validated = codrivingActionSchema.parse(action);
    this.assertWritable();
    this.runDatabase(() => {
      const db = this.requireDatabase();
      db.transaction(() => {
        db.prepare(`
          INSERT INTO session_events (
            action_id, sequence, digest, session_id, actor, kind, status, risk,
            summary, reason, approval_expires_at, created_at, updated_at
          ) VALUES (
            @id, @sequence, @digest, @sessionId, @actor, @kind, @status, @risk,
            @summary, @reason, @approvalExpiresAt, @createdAt, @updatedAt
          )
        `).run({ ...validated, approvalExpiresAt: validated.approvalExpiresAt ?? null });
        if (validated.approvalExpiresAt) {
          db.prepare(`
            INSERT INTO approvals (action_id, digest, status, expires_at, decided_at)
            VALUES (@id, @digest, @status, @expiresAt, @decidedAt)
            ON CONFLICT(action_id) DO UPDATE SET
              digest = excluded.digest,
              status = excluded.status,
              expires_at = excluded.expires_at,
              decided_at = excluded.decided_at
          `).run({
            id: validated.id,
            digest: validated.digest,
            status: validated.status,
            expiresAt: validated.approvalExpiresAt,
            decidedAt: validated.status === "pending_approval" ? null : validated.updatedAt
          });
        }
      })();
    });
  }
  saveCodrivingSessionState(state) {
    const validated = codrivingSessionStateSchema.parse(state);
    this.assertWritable();
    this.runDatabase(() => {
      this.requireDatabase().prepare(`
        INSERT INTO codriving_session_state (
          session_id, authorization_level, trusted_until, codex_paused, updated_at
        ) VALUES (@sessionId, @authorizationLevel, @trustedUntil, @codexPaused, @updatedAt)
        ON CONFLICT(session_id) DO UPDATE SET
          authorization_level = excluded.authorization_level,
          trusted_until = excluded.trusted_until,
          codex_paused = excluded.codex_paused,
          updated_at = excluded.updated_at
      `).run({
        ...validated,
        trustedUntil: validated.trustedUntil ?? null,
        codexPaused: validated.codexPaused ? 1 : 0
      });
    });
  }
  replaceRuntimeLeases(leases) {
    const validated = leases.map((lease) => runtimeLeaseRecordSchema.parse(lease));
    this.assertWritable();
    this.runDatabase(() => {
      const db = this.requireDatabase();
      db.transaction(() => {
        db.prepare("DELETE FROM runtime_leases").run();
        const insert = db.prepare(`
          INSERT INTO runtime_leases (lease_type, lease_id, updated_at)
          VALUES (@kind, @id, @updatedAt)
        `);
        for (const lease of validated) insert.run(lease);
      })();
    });
  }
  journalMode() {
    return this.runDatabase(() => String(this.requireDatabase().pragma("journal_mode", { simple: true })).toLowerCase());
  }
  hasSchema(table) {
    return this.runDatabase(() => Boolean(this.requireDatabase().prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table)));
  }
  assertWritable() {
    this.requireDatabase();
    if (this.status.migrationBlocked) {
      throw new Error(this.status.reason ?? "\u8FC1\u79FB\u5B89\u5168\u68C0\u67E5\u672A\u5B8C\u6210\uFF0C\u5DF2\u963B\u6B62\u6570\u636E\u5E93\u5199\u5165");
    }
  }
  close() {
    this.database?.close();
    this.database = void 0;
  }
  createSchema() {
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
      CREATE TABLE IF NOT EXISTS session_events (
        action_id TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        risk TEXT NOT NULL,
        summary TEXT NOT NULL,
        reason TEXT NOT NULL,
        approval_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (action_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS session_events_session_sequence
        ON session_events (session_id, sequence);
      CREATE TABLE IF NOT EXISTS approvals (
        action_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS codriving_session_state (
        session_id TEXT PRIMARY KEY,
        authorization_level TEXT NOT NULL,
        trusted_until TEXT,
        codex_paused INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_leases (
        lease_type TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (lease_type, lease_id)
      );
    `);
    this.ensureProfileTransferColumns();
  }
  ensureProfileTransferColumns() {
    const columns = this.requireDatabase().prepare("PRAGMA table_info(profiles)").all();
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("local_transfer_root")) {
      this.requireDatabase().exec("ALTER TABLE profiles ADD COLUMN local_transfer_root TEXT");
    }
    if (!names.has("remote_transfer_roots")) {
      this.requireDatabase().exec("ALTER TABLE profiles ADD COLUMN remote_transfer_roots TEXT NOT NULL DEFAULT '[]'");
    }
  }
  configureDatabase() {
    this.withBusyRetry(() => this.requireDatabase().pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`));
    this.withBusyRetry(() => this.requireDatabase().pragma("journal_mode = WAL"));
    this.withBusyRetry(() => this.requireDatabase().pragma("foreign_keys = ON"));
  }
  migrateLegacyJson(dataDir) {
    const observedState = this.getMigrationState();
    if (observedState === "complete") return;
    const observedBusinessData = this.hasBusinessData();
    let preparedLegacy;
    try {
      preparedLegacy = this.readLegacyJson(dataDir);
    } catch (error) {
      this.blockMigration(error instanceof Error ? error.message : "\u65E7 JSON \u6821\u9A8C\u5931\u8D25\uFF0C\u5DF2\u963B\u6B62\u8FC1\u79FB");
      return;
    }
    try {
      this.backupLegacyFiles(preparedLegacy, observedState === void 0 && !observedBusinessData);
    } catch (error) {
      this.handlePreMigrationFailure(error);
      return;
    }
    try {
      const migrate = this.requireDatabase().transaction(() => {
        const state = this.getMigrationState();
        if (state === "complete") return;
        const legacy = this.readLegacyJson(dataDir);
        if (!this.matchesLegacySnapshot(preparedLegacy, legacy)) {
          this.blockMigration("\u65E7 JSON \u5728\u5907\u4EFD\u540E\u53D1\u751F\u53D8\u5316\uFF0C\u5DF2\u963B\u6B62\u6570\u636E\u5E93\u5199\u5165");
          return;
        }
        if (state?.startsWith(IMPORTED_PREFIX)) {
          const imported = this.decodeImportedState(state);
          if (!imported || !this.matchesImportedState(imported, legacy)) {
            this.blockMigration("\u65E7 JSON \u6E90\u6587\u4EF6\u5DF2\u53D8\u5316\u6216\u8FC1\u79FB\u72B6\u6001\u4E0D\u5B8C\u6574\uFF0C\u5DF2\u963B\u6B62\u6570\u636E\u5E93\u5199\u5165");
            return;
          }
          try {
            this.verifyImport(legacy);
          } catch (error) {
            this.blockMigration(error instanceof Error ? error.message : "\u5DF2\u5BFC\u5165\u6570\u636E\u6821\u9A8C\u5931\u8D25\uFF0C\u5DF2\u963B\u6B62\u6570\u636E\u5E93\u5199\u5165");
            return;
          }
          this.setMigrationState("complete");
          return;
        }
        if (state !== void 0) {
          this.blockMigration("\u68C0\u6D4B\u5230\u672A\u77E5\u7684\u6570\u636E\u8FC1\u79FB\u72B6\u6001\uFF0C\u5DF2\u4FDD\u62A4\u73B0\u6709\u6570\u636E\u5E93\u6570\u636E");
          return;
        }
        if (this.hasBusinessData()) {
          this.blockMigration("\u6570\u636E\u5E93\u5DF2\u6709\u4E1A\u52A1\u6570\u636E\u4F46\u6CA1\u6709\u8FC1\u79FB\u72B6\u6001\uFF0C\u5DF2\u963B\u6B62\u8986\u76D6\u6216\u5220\u9664");
          return;
        }
        if (legacy.profileFile || legacy.historyFile) {
          this.importLegacyRecords(legacy);
          this.verifyImport(legacy);
        }
        this.setMigrationState("complete");
      });
      this.withBusyRetry(() => migrate.immediate());
    } catch (error) {
      if (this.isBusyError(error)) throw error;
      if (this.status.migrationBlocked) return;
      throw new SafeJsonFallbackError(error);
    }
  }
  importLegacyRecords(legacy) {
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
  readLegacyJson(dataDir) {
    const profiles = this.readLegacyArray(path3.join(dataDir, "profiles.json"), connectionProfileSchema);
    const history = this.readLegacyArray(path3.join(dataDir, "history.json"), commandRecordSchema);
    return {
      profiles: profiles.records,
      history: history.records,
      profileFile: profiles.file,
      historyFile: history.file,
      profileHash: profiles.hash,
      historyHash: history.hash
    };
  }
  readLegacyArray(file, schema) {
    if (!existsSync(file)) return { records: [] };
    const source = readFileSync(file);
    let parsed;
    try {
      parsed = JSON.parse(source.toString("utf8"));
    } catch (error) {
      throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u65E7\u6570\u636E\u6587\u4EF6 ${path3.basename(file)}\uFF1A${error instanceof Error ? error.message : "\u683C\u5F0F\u9519\u8BEF"}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u65E7\u6570\u636E\u6587\u4EF6 ${path3.basename(file)}\uFF1A\u6839\u8282\u70B9\u5FC5\u987B\u662F\u6570\u7EC4`);
    }
    return {
      records: parsed.map((item, index) => {
        const result = schema.safeParse(item);
        if (!result.success) {
          throw new Error(`\u65E7\u6570\u636E\u6587\u4EF6 ${path3.basename(file)} \u7B2C ${index + 1} \u6761\u8BB0\u5F55\u6821\u9A8C\u5931\u8D25\uFF1A${result.error.message}`);
        }
        return result.data;
      }),
      file,
      hash: createHash("sha256").update(source).digest("hex")
    };
  }
  verifyImport(legacy) {
    const importedProfiles = this.listProfiles();
    const importedHistory = this.listHistory();
    if (JSON.stringify(importedProfiles) !== JSON.stringify(legacy.profiles) || JSON.stringify(importedHistory) !== JSON.stringify(legacy.history)) {
      throw new Error("\u65E7\u6570\u636E\u5BFC\u5165\u540E\u7684\u5168\u5B57\u6BB5\u6821\u9A8C\u5931\u8D25");
    }
  }
  backupLegacyFiles(legacy, allowSourceMismatch = false) {
    for (const file of [legacy.profileFile, legacy.historyFile]) {
      if (!file) continue;
      const backup = `${file}.bak`;
      this.withFileBusyRetry(() => {
        const source = readFileSync(file);
        if (!existsSync(backup)) {
          try {
            this.backupOperations.copyFile(file, backup);
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
        const sourceUnchanged = source.equals(readFileSync(file));
        const backupMatches = source.equals(readFileSync(backup));
        if (!sourceUnchanged || !backupMatches && !allowSourceMismatch) {
          throw new Error(`\u65E7\u6570\u636E\u5907\u4EFD\u4E0E\u6E90\u6587\u4EF6\u4E0D\u4E00\u81F4\uFF0C\u62D2\u7EDD\u8FC1\u79FB\uFF1A${path3.basename(backup)}`);
        }
        this.backupOperations.chmod(backup, 292);
      });
    }
  }
  handlePreMigrationFailure(error) {
    const reason = error instanceof Error ? error.message : "\u65E7 JSON \u8BFB\u53D6\u6216\u5907\u4EFD\u5931\u8D25";
    const classify = this.requireDatabase().transaction(() => {
      const state = this.getMigrationState();
      if (state === "complete") return "complete";
      if (state !== void 0 || this.hasBusinessData()) return "blocked";
      return "fallback";
    });
    const outcome = this.withBusyRetry(() => classify.immediate());
    if (outcome === "complete") return;
    if (outcome === "fallback") throw new SafeJsonFallbackError(error);
    this.blockMigration(reason);
  }
  decodeImportedState(state) {
    try {
      const value = JSON.parse(state.slice(IMPORTED_PREFIX.length));
      if (!value || typeof value !== "object") return void 0;
      const candidate = value;
      if (candidate.profileHash !== void 0 && typeof candidate.profileHash !== "string" || candidate.historyHash !== void 0 && typeof candidate.historyHash !== "string") return void 0;
      return candidate;
    } catch {
      return void 0;
    }
  }
  matchesImportedState(imported, legacy) {
    return imported.profileHash === legacy.profileHash && imported.historyHash === legacy.historyHash;
  }
  matchesLegacySnapshot(expected, actual) {
    return expected.profileFile === actual.profileFile && expected.historyFile === actual.historyFile && expected.profileHash === actual.profileHash && expected.historyHash === actual.historyHash;
  }
  hasBusinessData() {
    const db = this.requireDatabase();
    const profiles = db.prepare("SELECT EXISTS(SELECT 1 FROM profiles LIMIT 1) AS has_data").get();
    const history = db.prepare("SELECT EXISTS(SELECT 1 FROM command_history LIMIT 1) AS has_data").get();
    const hostKeys = db.prepare("SELECT EXISTS(SELECT 1 FROM host_keys LIMIT 1) AS has_data").get();
    if (profiles.has_data === 1 || history.has_data === 1 || hostKeys.has_data === 1) return true;
    const externalTables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT IN ('migration_state', 'profiles', 'command_history', 'host_keys')
    `).all();
    return externalTables.some(({ name }) => {
      const identifier = `"${name.replaceAll('"', '""')}"`;
      const result = db.prepare(`SELECT EXISTS(SELECT 1 FROM ${identifier} LIMIT 1) AS has_data`).get();
      return result.has_data === 1;
    });
  }
  blockMigration(reason) {
    this.status.migrationBlocked = true;
    this.status.reason = reason;
  }
  getMigrationState() {
    return this.requireDatabase().prepare("SELECT value FROM migration_state WHERE key = ?").get(LEGACY_MIGRATION_KEY)?.value;
  }
  setMigrationState(value) {
    this.requireDatabase().prepare(
      `INSERT INTO migration_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(LEGACY_MIGRATION_KEY, value);
  }
  requireDatabase() {
    if (this.database) return this.database;
    if (this.status.unavailable) {
      this.recoverUnavailableDatabase();
      if (this.database) return this.database;
      throw new SqliteStoreUnavailableError(this.status.reason ?? "SQLite \u6570\u636E\u5E93\u6682\u4E0D\u53EF\u7528\uFF0C\u672A\u56DE\u9000\u5230 JSON");
    }
    throw new Error(this.status.reason ?? "SQLite \u6570\u636E\u5E93\u4E0D\u53EF\u7528\uFF0C\u5F53\u524D\u4F7F\u7528 JSON \u56DE\u9000");
  }
  recoverUnavailableDatabase() {
    try {
      this.database = new Database(this.databasePath, { timeout: BUSY_TIMEOUT_MS });
      this.configureDatabase();
      this.createSchema();
      this.status.migrationBlocked = false;
      this.migrateLegacyJson(this.dataDir);
      this.status.unavailable = false;
      this.status.usingJsonFallback = false;
      if (!this.status.migrationBlocked) this.status.reason = void 0;
    } catch (error) {
      this.applyInitializationFailure(error);
      this.close();
    }
  }
  applyInitializationFailure(error) {
    const safeFallback = error instanceof SafeJsonFallbackError;
    const busy = this.isBusyError(error);
    this.status.usingJsonFallback = safeFallback;
    this.status.unavailable = busy;
    this.status.migrationBlocked = !safeFallback && !busy;
    this.status.reason = error instanceof Error ? error.message : "SQLite \u521D\u59CB\u5316\u5931\u8D25";
  }
  runDatabase(operation) {
    try {
      this.requireDatabase();
      return this.withBusyRetry(operation);
    } catch (error) {
      if (this.isBusyError(error)) {
        this.status.unavailable = true;
        this.status.usingJsonFallback = false;
        this.status.reason = error instanceof Error ? error.message : "SQLite \u6570\u636E\u5E93\u88AB\u9501\u5B9A";
        this.close();
        throw new SqliteStoreUnavailableError(this.status.reason);
      }
      throw error;
    }
  }
  withBusyRetry(operation) {
    let lastError;
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
  withFileBusyRetry(operation) {
    let lastError;
    for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        lastError = error;
        const code = error.code;
        if (code !== "EBUSY" && code !== "EPERM" || attempt === BUSY_RETRIES - 1) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75 * (attempt + 1));
      }
    }
    throw lastError;
  }
  isBusyError(error) {
    return error instanceof Error && /database(?: table)? is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message);
  }
  toProfile(row) {
    const profile = {
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
    this.assignOptional(profile, "privateKeyPath", row.private_key_path);
    this.assignOptional(profile, "credentialId", row.credential_id);
    this.assignOptional(profile, "privateKeyPassphraseCredentialId", row.private_key_passphrase_credential_id);
    this.assignOptional(profile, "jumpHost", row.jump_host);
    this.assignOptional(profile, "localTransferRoot", row.local_transfer_root);
    const remoteTransferRoots = this.parseRemoteTransferRoots(row.remote_transfer_roots);
    if (remoteTransferRoots) profile.remoteTransferRoots = remoteTransferRoots;
    return connectionProfileSchema.parse(profile);
  }
  toHistory(row) {
    const record = {
      id: row.id,
      sessionId: row.session_id,
      command: row.command,
      startedAt: row.started_at,
      stdoutTail: row.stdout_tail,
      stderrTail: row.stderr_tail,
      summary: row.summary
    };
    this.assignOptional(record, "finishedAt", row.finished_at);
    if (typeof row.exit_code === "number") record.exitCode = row.exit_code;
    this.assignOptional(record, "signal", row.signal);
    return commandRecordSchema.parse(record);
  }
  toHostKey(row) {
    return trustedHostKeySchema.parse({
      profileId: row.profile_id,
      host: row.host,
      port: row.port,
      fingerprint: row.fingerprint,
      trustedAt: row.trusted_at,
      updatedAt: row.updated_at
    });
  }
  toCodrivingAction(row) {
    const action = {
      id: row.action_id,
      sequence: row.sequence,
      digest: row.digest,
      sessionId: row.session_id,
      actor: row.actor,
      kind: row.kind,
      status: row.status,
      risk: row.risk,
      summary: row.summary,
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    this.assignOptional(action, "approvalExpiresAt", row.approval_expires_at);
    return codrivingActionSchema.parse(action);
  }
  toCodrivingSessionState(row) {
    const state = {
      sessionId: row.session_id,
      authorizationLevel: row.authorization_level,
      codexPaused: row.codex_paused === 1,
      updatedAt: row.updated_at
    };
    this.assignOptional(state, "trustedUntil", row.trusted_until);
    return codrivingSessionStateSchema.parse(state);
  }
  assignOptional(target, key, value) {
    if (typeof value === "string") target[key] = value;
  }
  parseRemoteTransferRoots(value) {
    if (typeof value !== "string") return void 0;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") && parsed.length > 0 ? parsed : void 0;
    } catch {
      return void 0;
    }
  }
  profileParameters(profile) {
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
  historyParameters(record) {
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
};

// src/core/history-store.ts
var MAX_RECORDS = 500;
var HistoryStore = class {
  sqlite;
  store;
  constructor(options = {}) {
    this.sqlite = options.sqlite ?? new SqliteStore();
    this.store = options.jsonStore ?? new JsonStore("history.json", []);
  }
  async list(sessionId) {
    const records = this.sqlite.status.usingJsonFallback ? await this.store.read() : this.sqlite.listHistory();
    return sessionId ? records.filter((record) => record.sessionId === sessionId) : records;
  }
  async append(record) {
    const commandRecord = {
      id: randomUUID(),
      ...record
    };
    if (this.sqlite.status.usingJsonFallback) {
      const records = await this.store.read();
      await this.store.write([...records, commandRecord].slice(-MAX_RECORDS));
    } else {
      this.sqlite.appendHistory(commandRecord);
    }
    return commandRecord;
  }
};

// src/core/host-key-store.ts
var HostKeyStore = class {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }
  sqlite;
  get(profileId) {
    return this.sqlite.getHostKey(profileId);
  }
  confirm(challenge) {
    const validated = hostKeyTrustChallengeSchema.parse(challenge);
    const existing = this.sqlite.getHostKey(validated.profileId);
    if (validated.risk === "first_seen" && existing) {
      throw new Error("\u4E3B\u673A\u6307\u7EB9\u5DF2\u5B58\u5728\uFF0C\u62D2\u7EDD\u8986\u76D6\u9996\u6B21\u4FE1\u4EFB\u8BB0\u5F55");
    }
    if (validated.risk === "changed" && (!existing || existing.host !== validated.host || existing.port !== validated.port || existing.fingerprint !== validated.oldFingerprint)) {
      throw new Error("\u4E3B\u673A\u6307\u7EB9\u786E\u8BA4\u4FE1\u606F\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u5E76\u6838\u5BF9\u6307\u7EB9");
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return this.sqlite.saveHostKey({
      profileId: validated.profileId,
      host: validated.host,
      port: validated.port,
      fingerprint: validated.newFingerprint,
      trustedAt: existing?.trustedAt ?? now,
      updatedAt: now
    });
  }
};

// src/core/profile-store.ts
import { randomUUID as randomUUID2 } from "crypto";
var ProfileStore = class {
  constructor(credentialVault, options = {}) {
    this.credentialVault = credentialVault;
    this.sqlite = options.sqlite ?? new SqliteStore();
    this.store = options.jsonStore ?? new JsonStore("profiles.json", []);
  }
  credentialVault;
  sqlite;
  store;
  async list() {
    return this.usingJsonFallback() ? this.store.read() : this.sqlite.listProfiles();
  }
  async get(id) {
    const profile = (await this.list()).find((item) => item.id === id);
    if (!profile) {
      throw new Error(`\u8FDE\u63A5\u914D\u7F6E\u4E0D\u5B58\u5728\uFF1A${id}`);
    }
    return profile;
  }
  async save(input, id) {
    return this.saveWithOptions(input, id, false);
  }
  /** 导入时允许先建立不含密码的配置，用户再次编辑保存时仍必须补录密码。 */
  async importProfile(input) {
    return this.saveWithOptions(input, void 0, true);
  }
  async saveWithOptions(input, id, allowMissingSavedPassword) {
    const parsed = profileInputSchema.parse(input);
    const profiles = await this.list();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const existing = id ? profiles.find((item) => item.id === id) : void 0;
    const profileId = id ?? randomUUID2();
    const remoteTransferRoots = parsed.remoteTransferRoots?.map((root) => root.trim()).filter(Boolean);
    const passwordCredentialId = credentialId(profileId, "password");
    const passphraseCredentialId = credentialId(profileId, "private-key-passphrase");
    const credentialIds = new Set([
      existing?.credentialId,
      existing?.privateKeyPassphraseCredentialId,
      parsed.authMethod === "saved_password" ? passwordCredentialId : void 0,
      parsed.rememberPrivateKeyPassphrase ? passphraseCredentialId : void 0
    ].filter((value) => Boolean(value)));
    const originalSecrets = /* @__PURE__ */ new Map();
    for (const credential of credentialIds) {
      originalSecrets.set(credential, await this.credentialVault.getSecret(credential));
    }
    try {
      if (parsed.authMethod === "saved_password") {
        if (parsed.password) {
          await this.credentialVault.setSecret(passwordCredentialId, parsed.password);
        } else if (!existing?.credentialId && !allowMissingSavedPassword) {
          throw new Error("\u4FDD\u5B58\u5BC6\u7801\u8BA4\u8BC1\u65B9\u5F0F\u9700\u8981\u8F93\u5165\u5BC6\u7801");
        }
      } else {
        await this.credentialVault.deleteSecret(existing?.credentialId);
      }
      if (parsed.rememberPrivateKeyPassphrase && parsed.privateKeyPassphrase) {
        await this.credentialVault.setSecret(passphraseCredentialId, parsed.privateKeyPassphrase);
      } else if (!parsed.rememberPrivateKeyPassphrase) {
        await this.credentialVault.deleteSecret(existing?.privateKeyPassphraseCredentialId);
      }
      const profile = {
        id: profileId,
        name: parsed.name,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        authMethod: parsed.authMethod,
        privateKeyPath: parsed.privateKeyPath?.trim() || void 0,
        credentialId: parsed.authMethod === "saved_password" && (parsed.password || existing?.credentialId) ? passwordCredentialId : void 0,
        privateKeyPassphraseCredentialId: parsed.rememberPrivateKeyPassphrase ? passphraseCredentialId : void 0,
        connectTimeoutMs: parsed.connectTimeoutMs,
        keepaliveIntervalMs: parsed.keepaliveIntervalMs,
        jumpHost: parsed.jumpHost?.trim() || void 0,
        localTransferRoot: parsed.localTransferRoot?.trim() || void 0,
        remoteTransferRoots: remoteTransferRoots?.length ? remoteTransferRoots : void 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (this.usingJsonFallback()) {
        const next = existing ? profiles.map((item) => item.id === existing.id ? profile : item) : [...profiles, profile];
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
  async delete(id) {
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
  async restoreCredentials(secrets) {
    for (const [id, value] of secrets) {
      if (value === void 0) {
        await this.credentialVault.deleteSecret(id);
      } else {
        await this.credentialVault.setSecret(id, value);
      }
    }
  }
  usingJsonFallback() {
    return this.sqlite.status.usingJsonFallback;
  }
};

// src/core/ssh-session-manager.ts
import { EventEmitter } from "events";
import { readFile as readFile2 } from "fs/promises";
import { createHash as createHash2, randomUUID as randomUUID3 } from "crypto";
import path5 from "path";
import { Client } from "ssh2";

// src/core/command-policy.ts
var OTHER_HIGH_RISK = /^(?:mkfs(?:\..*)?|shutdown|reboot|poweroff|halt|fdisk|userdel|passwd|visudo|iptables|ufw|firewall-cmd)$/i;
var SHELL_EXECUTABLES = /* @__PURE__ */ new Set(["bash", "sh", "dash"]);
var WRITE_RISK_EXECUTABLES = /* @__PURE__ */ new Set([
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
  "mkdir",
  "touch",
  "tee",
  "apt",
  "apt-get",
  "yum",
  "dnf"
]);
var READONLY_EXECUTABLES = /* @__PURE__ */ new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "grep",
  "stat",
  "df",
  "du",
  "free",
  "top",
  "ps",
  "whoami",
  "id",
  "uname",
  "uptime"
]);
var COMPLEX_SHELL_SYNTAX = /(?:\r|\n|&|\|\||[;|<>`]|\$\()/;
var COMMON_EXECUTABLE_PATH = /^\/(?:usr\/)?s?bin\/([^/]+)$/i;
var ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
var MAX_COMMAND_LENGTH = 32768;
var MAX_WRAPPER_DEPTH = 32;
var COMMAND_OPTIONS_WITH_VALUE = /* @__PURE__ */ new Set();
var SUDO_OPTIONS_WITH_VALUE = /* @__PURE__ */ new Set([
  "-u",
  "-g",
  "-h",
  "-p",
  "-r",
  "-t",
  "-C",
  "-D",
  "--user",
  "--group",
  "--host",
  "--prompt",
  "--role",
  "--type",
  "--close-from",
  "--chdir"
]);
var ENV_OPTIONS_WITH_VALUE = /* @__PURE__ */ new Set(["-u", "-C", "--unset", "--chdir"]);
var SYSTEMCTL_OPTIONS_WITH_VALUE = /* @__PURE__ */ new Set([
  "-H",
  "-M",
  "-t",
  "-p",
  "-s",
  "--host",
  "--machine",
  "--type",
  "--state",
  "--property",
  "--output",
  "-o",
  "--lines",
  "--job-mode",
  "--root",
  "--image",
  "--image-policy",
  "--preset-mode",
  "--kill-who",
  "--signal",
  "--what",
  "--uid"
]);
function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      current += character;
      if (character === quote) {
        quote = void 0;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";" || character === "|" || character === "&" || /[\r\n]/.test(character)) {
      if (current.trim()) {
        segments.push(current);
      }
      current = "";
      if ((character === "|" || character === "&") && command[index + 1] === character) {
        index += 1;
      }
      continue;
    }
    current += character;
  }
  if (current.trim()) {
    segments.push(current);
  }
  return segments;
}
function tokenizeShellSegment(segment) {
  const tokens = [];
  let current = "";
  let quote;
  const pushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (quote) {
      if (character === quote) {
        quote = void 0;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "\\") {
      if (index + 1 < segment.length) {
        current += segment[index + 1];
        index += 1;
      } else {
        current += character;
      }
    } else if (/\s/.test(character)) {
      pushCurrent();
    } else {
      current += character;
    }
  }
  pushCurrent();
  return tokens;
}
function executableName(token) {
  if (/^[\w.-]+$/.test(token)) {
    return token.toLowerCase();
  }
  const commonExecutable = COMMON_EXECUTABLE_PATH.exec(token)?.[1];
  if (commonExecutable) {
    return commonExecutable.toLowerCase();
  }
  if (token.startsWith("/") && token.endsWith("/rm")) {
    return "rm";
  }
  return void 0;
}
function optionEnd(tokens, optionsWithValue) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      return index + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
    const optionName = token.split("=", 1)[0];
    if (optionsWithValue.has(optionName) && !token.includes("=")) {
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}
function parseActualCommand(tokens) {
  let remainingTokens = tokens;
  for (let wrapperDepth = 0; wrapperDepth <= MAX_WRAPPER_DEPTH; wrapperDepth += 1) {
    let index = 0;
    while (ENVIRONMENT_ASSIGNMENT.test(remainingTokens[index] ?? "")) {
      index += 1;
    }
    if (index >= remainingTokens.length) {
      return void 0;
    }
    const executable = executableName(remainingTokens[index]);
    if (!executable) {
      return void 0;
    }
    const args = remainingTokens.slice(index + 1);
    if (executable === "command" && (args[0] === "-v" || args[0] === "-V")) {
      return { executable, args };
    }
    const wrapperOptions = executable === "command" ? COMMAND_OPTIONS_WITH_VALUE : executable === "env" ? ENV_OPTIONS_WITH_VALUE : executable === "sudo" ? SUDO_OPTIONS_WITH_VALUE : void 0;
    if (!wrapperOptions) {
      return { executable, args };
    }
    if (wrapperDepth === MAX_WRAPPER_DEPTH) {
      return void 0;
    }
    remainingTokens = args.slice(optionEnd(args, wrapperOptions));
  }
  return void 0;
}
function systemctlCommand(args) {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    const optionName = token.split("=", 1)[0];
    if (SYSTEMCTL_OPTIONS_WITH_VALUE.has(optionName) && !token.includes("=")) {
      if (index + 1 >= args.length || args[index + 1].startsWith("-")) {
        return void 0;
      }
      index += 2;
    } else {
      index += 1;
    }
  }
  const executable = args[index]?.toLowerCase();
  return executable ? { executable, args: args.slice(index + 1) } : void 0;
}
function isReadonlyCommand(command) {
  const tokens = tokenizeShellSegment(command);
  const executable = executableName(tokens[0] ?? "");
  if (!executable) {
    return false;
  }
  const args = tokens.slice(1);
  if (READONLY_EXECUTABLES.has(executable)) {
    return true;
  }
  if (executable === "command") {
    return args[0] === "-v" || args[0] === "-V";
  }
  if (executable === "systemctl") {
    return systemctlCommand(args)?.executable === "status";
  }
  return false;
}
function isDestructiveRm(command) {
  if (command.executable !== "rm") {
    return false;
  }
  let recursive = false;
  for (const token of command.args) {
    if (token === "--") {
      break;
    }
    if (token === "--recursive") {
      recursive = true;
    } else if (/^-[^-]/.test(token)) {
      recursive ||= token.includes("r") || token.includes("R");
    }
  }
  return recursive;
}
function hasOtherHighRiskCommand(command) {
  if (command.executable === "dd") {
    return command.args.some(
      (argument) => argument.startsWith("if=") || argument.startsWith("of=")
    );
  }
  if (command.executable === "systemctl") {
    const systemctl = systemctlCommand(command.args);
    if (["poweroff", "reboot", "halt"].includes(systemctl?.executable ?? "")) {
      return true;
    }
    return systemctl?.executable === "restart" && systemctl.args.some((argument) => /^(?:ssh|sshd)(?:\.(?:service|socket))?$/i.test(argument));
  }
  return OTHER_HIGH_RISK.test(command.executable);
}
function isHighRiskCommand(command, shellDepth = 0) {
  return splitShellSegments(command).some((segment) => {
    const parsed = parseActualCommand(tokenizeShellSegment(segment));
    if (!parsed) {
      return false;
    }
    if (SHELL_EXECUTABLES.has(parsed.executable)) {
      const commandOption = parsed.args.findIndex(
        (argument) => argument === "-c" || /^-[^-]*c/.test(argument)
      );
      const script = parsed.args[commandOption + 1];
      return shellDepth < MAX_WRAPPER_DEPTH && commandOption >= 0 && Boolean(script) && isHighRiskCommand(script, shellDepth + 1);
    }
    return isDestructiveRm(parsed) || hasOtherHighRiskCommand(parsed);
  });
}
function isWriteRiskCommand(command, shellDepth = 0) {
  return splitShellSegments(command).some((segment) => {
    const parsed = parseActualCommand(tokenizeShellSegment(segment));
    if (!parsed) {
      return false;
    }
    if (SHELL_EXECUTABLES.has(parsed.executable)) {
      const commandOption = parsed.args.findIndex(
        (argument) => argument === "-c" || /^-[^-]*c/.test(argument)
      );
      const script = parsed.args[commandOption + 1];
      return shellDepth < MAX_WRAPPER_DEPTH && commandOption >= 0 && Boolean(script) && isWriteRiskCommand(script, shellDepth + 1);
    }
    if (WRITE_RISK_EXECUTABLES.has(parsed.executable)) {
      return true;
    }
    if (parsed.executable === "sed") {
      return parsed.args.some((argument) => /^-[^-]*i/.test(argument));
    }
    if (parsed.executable === "npm" || parsed.executable === "pnpm") {
      return parsed.args[0] === "i" || parsed.args[0] === "install";
    }
    if (parsed.executable === "docker") {
      return parsed.args[0] === "run" || parsed.args[0] === "compose";
    }
    if (parsed.executable === "systemctl") {
      const systemctl = systemctlCommand(parsed.args);
      return ["start", "stop", "restart", "enable", "disable"].includes(
        systemctl?.executable ?? ""
      );
    }
    return false;
  });
}
function assessCommand(command) {
  const trimmed = command.trim();
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return { risk: "write", reason: "\u547D\u4EE4\u8FC7\u957F\uFF0C\u65E0\u6CD5\u5B89\u5168\u5206\u7C7B\u4E3A\u53EA\u8BFB\u64CD\u4F5C" };
  }
  if (!trimmed) {
    return { risk: "write", reason: "\u7A7A\u547D\u4EE4\u4E0D\u80FD\u88AB\u786E\u8BA4\u4E3A\u53EA\u8BFB\u64CD\u4F5C" };
  }
  if (isHighRiskCommand(trimmed)) {
    return { risk: "high", reason: "\u547D\u4EE4\u53EF\u80FD\u5F71\u54CD\u7CFB\u7EDF\u3001\u7528\u6237\u3001\u78C1\u76D8\u6216 SSH \u8BBF\u95EE" };
  }
  if (COMPLEX_SHELL_SYNTAX.test(trimmed)) {
    return { risk: "write", reason: "\u590D\u5408 Shell \u8BED\u6CD5\u4E0D\u80FD\u81EA\u52A8\u786E\u8BA4\u4E3A\u53EA\u8BFB\u64CD\u4F5C" };
  }
  if (isWriteRiskCommand(trimmed)) {
    return { risk: "write", reason: "\u547D\u4EE4\u53EF\u80FD\u4FEE\u6539\u8FDC\u7A0B\u670D\u52A1\u5668\u72B6\u6001" };
  }
  if (isReadonlyCommand(trimmed)) {
    return { risk: "readonly", reason: "\u547D\u4EE4\u5C5E\u4E8E\u660E\u786E\u7684\u5355\u6761\u53EA\u8BFB\u68C0\u67E5" };
  }
  return { risk: "write", reason: "\u65E0\u6CD5\u786E\u8BA4\u547D\u4EE4\u53EA\u8BFB\uFF0C\u6309\u5199\u64CD\u4F5C\u5904\u7406" };
}
function authorizeCommand(authorizationLevel, command) {
  const assessment = assessCommand(command);
  return {
    ...assessment,
    allowed: authorizationLevel === "ask_every_time" || authorizationLevel === "auto_readonly" && assessment.risk === "readonly" || authorizationLevel === "trusted_session" && assessment.risk !== "high"
  };
}
function authorizeTransfer(authorizationLevel, direction) {
  const readonly = direction === "download";
  return {
    risk: readonly ? "readonly" : "write",
    reason: readonly ? "\u4E0B\u8F7D\u4E0D\u4F1A\u4FEE\u6539\u8FDC\u7A0B\u670D\u52A1\u5668\u6587\u4EF6" : "\u4E0A\u4F20\u4F1A\u4FEE\u6539\u8FDC\u7A0B\u670D\u52A1\u5668\u6587\u4EF6",
    allowed: authorizationLevel !== "auto_readonly" || readonly
  };
}
function enforceCommandAuthorization(authorizationLevel, command) {
  const authorization = authorizeCommand(authorizationLevel, command);
  if (!authorization.allowed) {
    if (authorizationLevel === "trusted_session") {
      throw new Error(`\u9AD8\u5371\u64CD\u4F5C\u4ECD\u9700\u9010\u6B21\u5BA1\u6279\uFF0C\u8BF7\u5207\u6362\u5230\u201C\u6BCF\u6B21\u8BE2\u95EE\u201D\u540E\u91CD\u8BD5\uFF1A${authorization.reason}`);
    }
    throw new Error(`\u5F53\u524D\u4F1A\u8BDD\u4E3A\u201C\u53EA\u8BFB\u81EA\u52A8\u201D\uFF0C\u5DF2\u62D2\u7EDD ${authorization.risk} \u64CD\u4F5C\uFF1A${authorization.reason}`);
  }
}
function enforceTransferAuthorization(authorizationLevel, direction) {
  const authorization = authorizeTransfer(authorizationLevel, direction);
  if (!authorization.allowed) {
    throw new Error(
      `\u5F53\u524D\u4F1A\u8BDD\u4E3A\u201C\u53EA\u8BFB\u81EA\u52A8\u201D\uFF0C\u5DF2\u62D2\u7EDD\u6587\u4EF6${direction === "upload" ? "\u4E0A\u4F20" : "\u4E0B\u8F7D"}\uFF1A${authorization.reason}`
    );
  }
}

// src/core/command-redaction.ts
import { parse } from "shell-quote";

// src/core/redaction.ts
var SECRET_PATTERNS = [
  {
    pattern: /((?:"password"|'password'|password)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: "$1$2[REDACTED]$2"
  },
  {
    pattern: /((?:"access_token"|'access_token'|access_token)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: "$1$2[REDACTED]$2"
  },
  {
    pattern: /((?:"refresh_token"|'refresh_token'|refresh_token)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: "$1$2[REDACTED]$2"
  },
  {
    pattern: /((?:"token"|'token'|token)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: "$1$2[REDACTED]$2"
  },
  {
    pattern: /((?:"api[_-]?key"|'api[_-]?key'|api[_-]?key)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: "$1$2[REDACTED]$2"
  },
  {
    pattern: /((?:"client_secret"|'client_secret'|client_secret)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: "$1$2[REDACTED]$2"
  },
  {
    pattern: /((?:"secret"|'secret'|secret)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: "$1$2[REDACTED]$2"
  },
  {
    pattern: /("authorization"\s*:\s*")(?:\\.|[^"\\])*"/gi,
    replacement: '$1[REDACTED]"'
  },
  {
    pattern: /("cookie"\s*:\s*")(?:\\.|[^"\\])*"/gi,
    replacement: '$1[REDACTED]"'
  },
  {
    pattern: /(?<![!#$%&'*+\-.^_`|~0-9A-Za-z])(authorization\s*:\s*bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /(?<![!#$%&'*+\-.^_`|~0-9A-Za-z])(cookie\s*:\s*)[^\r\n]*/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /(postgres(?:ql)?:\/\/[^\s/:@'"`]+:)[^\s/@'"`]+@/gi,
    replacement: "$1[REDACTED]@"
  },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED]"
  }
];
function redact(value) {
  return SECRET_PATTERNS.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    value
  );
}
function tail(value, maxChars = 12e3) {
  const redacted = redact(value);
  return redacted.length > maxChars ? redacted.slice(redacted.length - maxChars) : redacted;
}

// src/core/command-redaction.ts
var SENSITIVE_COMMAND = "[REDACTED:SENSITIVE_COMMAND]";
var SENSITIVE_HEADER = /(?<![!#$%&'*+\-.^_`|~0-9A-Za-z])(?:cookie|authorization)\s*:/i;
var ATTACHED_HEADER = /^(?:-H|--header=)(?:cookie|authorization)\s*:/i;
function redactCommand(command) {
  try {
    const hasSensitiveHeader = parse(command).some((entry) => {
      const value = typeof entry === "string" ? entry : "op" in entry && entry.op === "glob" ? entry.pattern : void 0;
      return value !== void 0 && (SENSITIVE_HEADER.test(value) || ATTACHED_HEADER.test(value));
    });
    return hasSensitiveHeader ? SENSITIVE_COMMAND : redact(command);
  } catch {
    return SENSITIVE_HEADER.test(command) || ATTACHED_HEADER.test(command) ? SENSITIVE_COMMAND : redact(command);
  }
}

// src/core/file-boundary.ts
import { realpath } from "fs/promises";
import path4 from "path";
var FileBoundary = class {
  constructor(options) {
    this.options = options;
  }
  options;
  async resolve(request) {
    const localPath = request.direction === "upload" ? await this.resolveUploadSource(request.localPath) : await this.resolveDownloadTarget(request.localPath);
    return { localPath, remotePath: this.resolveRemotePath(request.remotePath) };
  }
  async resolveUploadSource(localPath) {
    const root = await this.resolveLocalRoot();
    const candidate = await this.resolveExistingPath(localPath, "\u672C\u5730\u4E0A\u4F20\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u65E0\u6CD5\u89E3\u6790");
    this.assertLocalContained(root, candidate);
    return candidate;
  }
  async resolveDownloadTarget(localPath) {
    const root = await this.resolveLocalRoot();
    const parent = await this.resolveExistingPath(path4.dirname(localPath), "\u672C\u5730\u4E0B\u8F7D\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u65E0\u6CD5\u89E3\u6790");
    this.assertLocalContained(root, parent);
    try {
      const existingTarget = await realpath(localPath);
      this.assertLocalContained(root, existingTarget);
      return existingTarget;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error("\u672C\u5730\u4E0B\u8F7D\u76EE\u6807\u65E0\u6CD5\u5B89\u5168\u89E3\u6790");
      }
      const target = path4.join(parent, path4.basename(localPath));
      this.assertLocalContained(root, target);
      return target;
    }
  }
  async resolveLocalRoot() {
    if (!this.options.localRoot?.trim()) {
      throw new Error("\u672A\u914D\u7F6E\u672C\u5730\u6587\u4EF6\u4F20\u8F93\u5141\u8BB8\u76EE\u5F55");
    }
    return this.resolveExistingPath(this.options.localRoot, "\u672C\u5730\u6587\u4EF6\u4F20\u8F93\u5141\u8BB8\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u65E0\u6CD5\u89E3\u6790");
  }
  async resolveExistingPath(candidate, message) {
    try {
      return await realpath(candidate);
    } catch {
      throw new Error(message);
    }
  }
  assertLocalContained(root, candidate) {
    const compareRoot = process.platform === "win32" ? root.toLocaleLowerCase() : root;
    const compareCandidate = process.platform === "win32" ? candidate.toLocaleLowerCase() : candidate;
    const relative = path4.relative(compareRoot, compareCandidate);
    if (relative === ".." || relative.startsWith(`..${path4.sep}`) || path4.isAbsolute(relative)) {
      throw new Error("\u672C\u5730\u6587\u4EF6\u8DEF\u5F84\u4E0D\u5728\u5141\u8BB8\u76EE\u5F55\u5185");
    }
  }
  resolveRemotePath(remotePath) {
    if (!this.options.remoteRoots.length) {
      throw new Error("\u672A\u914D\u7F6E\u8FDC\u7A0B\u6587\u4EF6\u4F20\u8F93\u5141\u8BB8\u76EE\u5F55");
    }
    const normalized = this.normalizeRemotePath(remotePath, "\u8FDC\u7A0B\u6587\u4EF6\u8DEF\u5F84\u4E0D\u5728\u5141\u8BB8\u76EE\u5F55\u5185");
    const allowed = this.options.remoteRoots.some((root) => this.isRemoteContained(root, normalized));
    if (!allowed) {
      throw new Error("\u8FDC\u7A0B\u6587\u4EF6\u8DEF\u5F84\u4E0D\u5728\u5141\u8BB8\u76EE\u5F55\u5185");
    }
    return normalized;
  }
  resolveRemoteBrowsePath(remotePath) {
    return this.normalizeRemotePath(remotePath, "\u8FDC\u7A0B\u6D4F\u89C8\u8DEF\u5F84\u65E0\u6548");
  }
  normalizeRemotePath(remotePath, message) {
    if (!remotePath.startsWith("/") || remotePath.split("/").includes("..") || remotePath.includes("\0")) {
      throw new Error(message);
    }
    return path4.posix.normalize(remotePath);
  }
  isRemoteContained(root, candidate) {
    if (!root.startsWith("/") || root.split("/").includes("..")) return false;
    const normalizedRoot = path4.posix.normalize(root);
    return normalizedRoot === "/" ? candidate.startsWith("/") : candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
  }
};

// src/core/ssh-session-manager.ts
var TERMINAL_TRANSCRIPT_LIMIT = 64 * 1024;
function summarizeCommand(command, stdout, stderr, exitCode) {
  const risk = assessCommand(command);
  const stdoutLines = stdout.trim() ? stdout.trim().split(/\r?\n/).length : 0;
  const stderrLines = stderr.trim() ? stderr.trim().split(/\r?\n/).length : 0;
  return `Risk: ${risk.risk}; exit code: ${exitCode ?? "unknown"}; stdout ${stdoutLines} lines; stderr ${stderrLines} lines.`;
}
function formatSshError(error) {
  if (error instanceof Error) {
    return redact(error.message);
  }
  return redact(String(error));
}
function sanitizedError(error) {
  return new Error(formatSshError(error));
}
var SshSessionManager = class extends EventEmitter {
  constructor(profiles, credentials, history, hostKeys, clientFactory = () => new Client(), fileBoundaryForProfile = (profile) => new FileBoundary({
    localRoot: profile.localTransferRoot,
    remoteRoots: profile.remoteTransferRoots ?? []
  })) {
    super();
    this.profiles = profiles;
    this.credentials = credentials;
    this.history = history;
    this.hostKeys = hostKeys;
    this.clientFactory = clientFactory;
    this.fileBoundaryForProfile = fileBoundaryForProfile;
  }
  profiles;
  credentials;
  history;
  hostKeys;
  clientFactory;
  fileBoundaryForProfile;
  sessions = /* @__PURE__ */ new Map();
  /** 同一 profile 的握手只允许一个 in-flight Promise，供守卫和并发调用共同使用。 */
  openingSessions = /* @__PURE__ */ new Map();
  pendingHostKeyChallenges = /* @__PURE__ */ new Map();
  listSessions() {
    return [...this.sessions.values()].map((managed) => managed.session);
  }
  getSession(sessionId) {
    return this.getManaged(sessionId).session;
  }
  setAuthorizationLevel(sessionId, authorizationLevel) {
    const session = this.getManaged(sessionId).session;
    session.authorizationLevel = authorizationLevel;
    this.emit("session-updated", session);
    return session;
  }
  assertProfileCanBeUpdated(profileId, endpoint) {
    const active = this.findActiveProfileSession(profileId);
    if (this.openingSessions.has(profileId)) {
      throw new Error("\u5F53\u524D\u914D\u7F6E\u6B63\u5728\u5EFA\u7ACB\u4F1A\u8BDD\uFF0C\u8BF7\u7B49\u5F85\u8FDE\u63A5\u5B8C\u6210\u6216\u5931\u8D25\u540E\u518D\u4FEE\u6539\u4E3B\u673A\u6216\u7AEF\u53E3");
    }
    if (active && (active.profile.host !== endpoint.host || active.profile.port !== endpoint.port)) {
      throw new Error("\u5F53\u524D\u914D\u7F6E\u5B58\u5728\u6D3B\u8DC3\u4F1A\u8BDD\uFF0C\u8BF7\u5148\u5173\u95ED\u4F1A\u8BDD\u540E\u518D\u4FEE\u6539\u4E3B\u673A\u6216\u7AEF\u53E3");
    }
  }
  assertProfileCanBeDeleted(profileId) {
    if (this.openingSessions.has(profileId)) {
      throw new Error("\u5F53\u524D\u914D\u7F6E\u6B63\u5728\u5EFA\u7ACB\u4F1A\u8BDD\uFF0C\u8BF7\u7B49\u5F85\u8FDE\u63A5\u5B8C\u6210\u6216\u5931\u8D25\u540E\u518D\u5220\u9664\u914D\u7F6E");
    }
    if (this.findActiveProfileSession(profileId)) {
      throw new Error("\u5F53\u524D\u914D\u7F6E\u5B58\u5728\u6D3B\u8DC3\u4F1A\u8BDD\uFF0C\u8BF7\u5148\u5173\u95ED\u4F1A\u8BDD\u540E\u518D\u5220\u9664\u914D\u7F6E");
    }
  }
  listHostKeyTrustChallenges() {
    return [...this.pendingHostKeyChallenges.values()].map((challenge) => ({ ...challenge }));
  }
  async confirmHostKeyTrust(confirmation) {
    const pending = this.pendingHostKeyChallenges.get(confirmation.profileId);
    if (!pending || pending.challengeId !== confirmation.challengeId) {
      throw new Error("\u6CA1\u6709\u5339\u914D\u7684\u5F85\u786E\u8BA4\u4E3B\u673A\u6307\u7EB9\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u8FDE\u63A5\u5E76\u6838\u5BF9\u98CE\u9669\u4FE1\u606F");
    }
    const profile = await this.profiles.get(confirmation.profileId);
    if (profile.host !== pending.host || profile.port !== pending.port) {
      this.pendingHostKeyChallenges.delete(confirmation.profileId);
      throw new Error("\u8FDE\u63A5\u914D\u7F6E\u7684\u4E3B\u673A\u6216\u7AEF\u53E3\u5DF2\u53D8\u5316\uFF0C\u5DF2\u4E22\u5F03\u65E7\u6307\u7EB9\u786E\u8BA4\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5");
    }
    if (this.pendingHostKeyChallenges.get(confirmation.profileId)?.challengeId !== confirmation.challengeId) {
      throw new Error("\u4E3B\u673A\u6307\u7EB9\u786E\u8BA4\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u8FDE\u63A5\u5E76\u6838\u5BF9\u98CE\u9669\u4FE1\u606F");
    }
    this.hostKeys.confirm(pending);
    this.pendingHostKeyChallenges.delete(confirmation.profileId);
  }
  discardHostKeyChallenge(profileId) {
    this.pendingHostKeyChallenges.delete(profileId);
  }
  discardPendingHostKeyChallenge(profileId) {
    this.discardHostKeyChallenge(profileId);
  }
  async openSession(profileId, authorizationLevel) {
    const existing = [...this.sessions.values()].find((item) => item.profile.id === profileId);
    if (existing && existing.session.health !== "disconnected") {
      if (authorizationLevel) existing.session.authorizationLevel = authorizationLevel;
      return existing.session;
    }
    const opening = this.openingSessions.get(profileId);
    if (opening) {
      const session = await opening;
      if (authorizationLevel) session.authorizationLevel = authorizationLevel;
      return session;
    }
    const openingSession = this.openSessionOnce(profileId, authorizationLevel ?? "ask_every_time");
    this.openingSessions.set(profileId, openingSession);
    try {
      return await openingSession;
    } finally {
      if (this.openingSessions.get(profileId) === openingSession) {
        this.openingSessions.delete(profileId);
      }
    }
  }
  async openSessionOnce(profileId, authorizationLevel) {
    const profile = await this.profiles.get(profileId);
    const client = this.clientFactory();
    const session = {
      id: randomUUID3(),
      profileId: profile.id,
      profileName: profile.name,
      health: "degraded",
      authorizationLevel,
      openedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const managed = {
      session,
      profile,
      client,
      commandTail: Promise.resolve()
    };
    client.on("error", (error) => {
      session.health = "degraded";
      session.lastError = formatSshError(error);
      this.emit("session-updated", session);
    });
    client.on("close", () => {
      session.health = "disconnected";
      this.emit("session-updated", session);
    });
    await this.connectClient(client, profile);
    session.health = "connected";
    session.lastCheckedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.sessions.set(session.id, managed);
    return session;
  }
  async closeSession(sessionId) {
    const managed = this.getManaged(sessionId);
    managed.terminal?.stream.end();
    managed.client.end();
    managed.session.health = "disconnected";
    this.sessions.delete(sessionId);
  }
  async getHealth(sessionId) {
    const managed = this.getManaged(sessionId);
    try {
      await this.execRaw(managed.client, "true", 5e3);
      managed.session.health = "connected";
      managed.session.lastError = void 0;
    } catch (error) {
      managed.session.health = "degraded";
      managed.session.lastError = formatSshError(error);
    }
    managed.session.lastCheckedAt = (/* @__PURE__ */ new Date()).toISOString();
    return managed.session;
  }
  async runCommand(sessionId, command) {
    const managed = this.getManaged(sessionId);
    if (managed.session.health === "disconnected") {
      throw new Error("\u8FDE\u63A5\u4F1A\u8BDD\u5DF2\u65AD\u5F00\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5");
    }
    enforceCommandAuthorization(managed.session.authorizationLevel, command);
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const result = await this.execRaw(managed.client, command);
    return this.recordCommand(sessionId, command, startedAt, result);
  }
  async executeCommand(sessionId, command, options = {}) {
    const managed = this.getManaged(sessionId);
    if (managed.session.health === "disconnected") {
      throw new Error("\u8FDE\u63A5\u4F1A\u8BDD\u5DF2\u65AD\u5F00\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5");
    }
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.openTerminal(sessionId);
    const result = await this.enqueueTerminalCommand(
      managed,
      command,
      options.echoCommand ?? true,
      options.beforeStart
    );
    return this.recordCommand(sessionId, command, startedAt, result);
  }
  async recordCommand(sessionId, command, startedAt, result) {
    const redactedCommand = redactCommand(command);
    const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    const stdoutTail = tail(result.stdout);
    const stderrTail = tail(result.stderr);
    const record = await this.history.append({
      sessionId,
      command: redactedCommand,
      startedAt,
      finishedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutTail,
      stderrTail,
      summary: summarizeCommand(command, stdoutTail, stderrTail, result.exitCode)
    });
    return {
      record,
      stdout: stdoutTail,
      stderr: stderrTail
    };
  }
  async transferFile(request) {
    const managed = this.getManaged(request.sessionId);
    enforceTransferAuthorization(managed.session.authorizationLevel, request.direction);
    return this.executeFileTransfer(request);
  }
  async executeFileTransfer(request) {
    const managed = this.getManaged(request.sessionId);
    const resolvedPaths = await this.fileBoundaryForProfile(managed.profile).resolve(request);
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    await new Promise((resolve, reject) => {
      managed.client.sftp((error, sftp) => {
        if (error) {
          reject(sanitizedError(error));
          return;
        }
        const callback = (transferError) => {
          sftp.end();
          if (transferError) {
            reject(sanitizedError(transferError));
          } else {
            resolve();
          }
        };
        if (request.direction === "upload") {
          sftp.fastPut(resolvedPaths.localPath, resolvedPaths.remotePath, callback);
        } else {
          sftp.fastGet(resolvedPaths.remotePath, resolvedPaths.localPath, callback);
        }
      });
    });
    return {
      id: randomUUID3(),
      direction: request.direction,
      localPath: resolvedPaths.localPath,
      remotePath: resolvedPaths.remotePath,
      startedAt,
      finishedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  async listRemoteDirectory(sessionId, remotePath) {
    const managed = this.getManaged(sessionId);
    const boundary = this.fileBoundaryForProfile(managed.profile);
    const directory = boundary.resolveRemoteBrowsePath(remotePath);
    return new Promise((resolve, reject) => {
      managed.client.sftp((error, sftp) => {
        if (error) {
          reject(sanitizedError(error));
          return;
        }
        sftp.readdir(directory, (readError, list) => {
          sftp.end();
          if (readError) {
            reject(sanitizedError(readError));
            return;
          }
          const entries = list.flatMap((entry) => {
            if (!entry.filename || entry.filename === "." || entry.filename === ".." || entry.filename.includes("/")) {
              return [];
            }
            let childPath;
            try {
              childPath = boundary.resolveRemoteBrowsePath(path5.posix.join(directory, entry.filename));
            } catch {
              return [];
            }
            const type = entry.attrs.isDirectory() ? "directory" : entry.attrs.isFile() ? "file" : entry.attrs.isSymbolicLink() ? "symlink" : "other";
            return [{
              name: entry.filename,
              path: childPath,
              type,
              size: entry.attrs.size,
              modifiedAt: entry.attrs.mtime > 0 ? new Date(entry.attrs.mtime * 1e3).toISOString() : void 0
            }];
          });
          entries.sort((left, right) => {
            if (left.type === "directory" && right.type !== "directory") return -1;
            if (left.type !== "directory" && right.type === "directory") return 1;
            return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
          });
          resolve(entries);
        });
      });
    });
  }
  async openTerminal(sessionId) {
    const managed = this.getManaged(sessionId);
    if (managed.terminal) return managed.terminal.id;
    if (managed.terminalOpening) return (await managed.terminalOpening).id;
    managed.terminalOpening = this.createTerminal(managed);
    try {
      return (await managed.terminalOpening).id;
    } finally {
      managed.terminalOpening = void 0;
    }
  }
  getTerminalReplay(terminalId) {
    return this.findTerminal(terminalId).transcript;
  }
  getTerminalSessionId(terminalId) {
    return this.findTerminal(terminalId).sessionId;
  }
  createTerminal(managed) {
    const terminalId = randomUUID3();
    return new Promise((resolve, reject) => {
      managed.client.shell({ term: "xterm-256color", cols: 120, rows: 32 }, (error, stream) => {
        if (error) {
          reject(sanitizedError(error));
          return;
        }
        const terminal = {
          id: terminalId,
          sessionId: managed.session.id,
          stream,
          transcript: ""
        };
        managed.terminal = terminal;
        stream.on("data", (data) => {
          this.consumeTerminalData(terminal, data.toString("utf8"));
        });
        stream.stderr.on("data", (data) => {
          this.emitTerminalData(terminal, data.toString("utf8"));
        });
        stream.on("close", () => {
          if (terminal.pending) {
            clearTimeout(terminal.pending.timeout);
            terminal.pending.reject(new Error("\u5171\u4EAB\u7EC8\u7AEF\u5DF2\u5173\u95ED\uFF0C\u547D\u4EE4\u672A\u5B8C\u6210"));
            terminal.pending = void 0;
          }
          if (managed.terminal?.id === terminalId) managed.terminal = void 0;
        });
        resolve(terminal);
      });
    });
  }
  runTerminalCommand(sessionId, terminalId, command) {
    const managed = this.getManaged(sessionId);
    const terminal = managed.terminal;
    if (!terminal || terminal.id !== terminalId) {
      throw new Error(`\u5F53\u524D\u4F1A\u8BDD\u4E2D\u4E0D\u5B58\u5728\u7EC8\u7AEF\uFF1A${terminalId}`);
    }
    enforceCommandAuthorization(managed.session.authorizationLevel, command);
    terminal.stream.write(`${command}\r`);
  }
  writeTerminal(terminalId, data) {
    const terminal = this.findTerminal(terminalId);
    terminal.stream.write(data);
  }
  closeTerminal(terminalId) {
    this.findTerminal(terminalId);
  }
  enqueueTerminalCommand(managed, command, echoCommand, beforeStart) {
    const previous = managed.commandTail;
    let release;
    managed.commandTail = new Promise((resolve) => {
      release = resolve;
    });
    return previous.then(() => {
      beforeStart?.();
      return this.executeTerminalCommand(managed, command, echoCommand);
    }).finally(release);
  }
  executeTerminalCommand(managed, command, echoCommand) {
    const terminal = managed.terminal;
    if (!terminal) throw new Error("\u5171\u4EAB\u7EC8\u7AEF\u5C1A\u672A\u5EFA\u7ACB");
    if (terminal.pending) throw new Error("\u5171\u4EAB\u7EC8\u7AEF\u4ECD\u6709\u524D\u53F0\u547D\u4EE4\u8FD0\u884C\uFF0C\u4E0D\u80FD\u542F\u52A8\u4E0B\u4E00\u6761\u547D\u4EE4");
    const token = randomUUID3().replaceAll("-", "");
    const markerPrefix = `ORBITSSH:${token}:`;
    const wrapper = `${command}; __orbitssh_code=$?; printf '\\036ORBITSSH:${token}:%s\\037' "$__orbitssh_code"\r`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (terminal.pending?.markerPrefix !== markerPrefix) return;
        terminal.pending.settled = true;
        reject(new Error("\u5171\u4EAB\u7EC8\u7AEF\u547D\u4EE4\u6267\u884C\u8D85\u65F6"));
      }, 12e4);
      terminal.pending = {
        command,
        echoCommand,
        wrapper,
        markerPrefix,
        buffer: "",
        stdout: "",
        echoHandled: false,
        settled: false,
        timeout,
        resolve,
        reject
      };
      terminal.stream.write(wrapper);
    });
  }
  consumeTerminalData(terminal, data) {
    const pending = terminal.pending;
    if (!pending) {
      this.emitTerminalData(terminal, data);
      return;
    }
    pending.buffer += data;
    if (!pending.echoHandled) {
      const wrapperStart = pending.buffer.indexOf(pending.wrapper);
      if (wrapperStart >= 0) {
        const prefix = pending.buffer.slice(0, wrapperStart);
        if (prefix) this.emitTerminalData(terminal, prefix);
        if (pending.echoCommand) this.emitTerminalData(terminal, `${pending.command}\r`);
        pending.buffer = pending.buffer.slice(wrapperStart + pending.wrapper.length);
        pending.echoHandled = true;
      } else if (pending.buffer.includes(pending.markerPrefix) || pending.buffer.length > pending.wrapper.length + 1024) {
        pending.echoHandled = true;
      } else {
        return;
      }
    }
    const markerStart = pending.buffer.indexOf(pending.markerPrefix);
    if (markerStart < 0) {
      const safeLength = Math.max(0, pending.buffer.length - pending.markerPrefix.length);
      if (safeLength > 0) {
        const visible = pending.buffer.slice(0, safeLength);
        pending.stdout = `${pending.stdout}${visible}`.slice(-TERMINAL_TRANSCRIPT_LIMIT);
        pending.buffer = pending.buffer.slice(safeLength);
        this.emitTerminalData(terminal, visible);
      }
      return;
    }
    const markerEnd = pending.buffer.indexOf("", markerStart + pending.markerPrefix.length);
    if (markerEnd < 0) return;
    const beforeMarker = pending.buffer.slice(0, markerStart);
    const exitCodeText = pending.buffer.slice(markerStart + pending.markerPrefix.length, markerEnd);
    const afterMarker = pending.buffer.slice(markerEnd + 1);
    const stdout = `${pending.stdout}${beforeMarker}`.replace(/^\r?\n/, "");
    clearTimeout(pending.timeout);
    terminal.pending = void 0;
    if (beforeMarker) this.emitTerminalData(terminal, beforeMarker);
    if (afterMarker) this.emitTerminalData(terminal, afterMarker);
    const exitCode = Number.parseInt(exitCodeText, 10);
    if (!pending.settled) {
      pending.settled = true;
      pending.resolve({ stdout, stderr: "", exitCode: Number.isNaN(exitCode) ? void 0 : exitCode });
    }
  }
  emitTerminalData(terminal, data) {
    terminal.transcript = `${terminal.transcript}${data}`.slice(-TERMINAL_TRANSCRIPT_LIMIT);
    const chunk = { sessionId: terminal.sessionId, terminalId: terminal.id, data };
    this.emit("terminal-data", chunk);
  }
  async connectClient(client, profile) {
    let config;
    try {
      config = await this.createConnectConfig(profile);
    } catch (error) {
      throw sanitizedError(error);
    }
    await new Promise((resolve, reject) => {
      let hostKeyFailure;
      const cleanup = () => {
        client.off("ready", onReady);
        client.off("error", onError);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(hostKeyFailure ?? sanitizedError(error));
      };
      client.once("ready", onReady);
      client.once("error", onError);
      config.hostVerifier = (key) => {
        try {
          const challenge = this.createHostKeyChallenge(profile, key);
          if (!challenge) return true;
          this.pendingHostKeyChallenges.set(profile.id, challenge);
          hostKeyFailure = new Error(challenge.risk === "changed" ? "SSH \u4E3B\u673A\u6307\u7EB9\u5DF2\u53D8\u5316\uFF0C\u5DF2\u62D2\u7EDD\u8FDE\u63A5\u3002\u8BF7\u5728\u684C\u9762\u7AEF\u6838\u5BF9\u65E7/\u65B0\u6307\u7EB9\u53CA\u4E2D\u95F4\u4EBA\u653B\u51FB\u98CE\u9669\u540E\u786E\u8BA4\u66FF\u6362\u3002" : "\u53D1\u73B0\u672A\u77E5 SSH \u4E3B\u673A\u6307\u7EB9\uFF0C\u5DF2\u62D2\u7EDD\u8FDE\u63A5\u3002\u8BF7\u5728\u684C\u9762\u7AEF\u6838\u5BF9\u6307\u7EB9\u540E\u786E\u8BA4\u4FE1\u4EFB\u3002");
          return false;
        } catch {
          hostKeyFailure = new Error("\u65E0\u6CD5\u5B89\u5168\u8BFB\u53D6\u4E3B\u673A\u6307\u7EB9\u4FE1\u4EFB\u8BB0\u5F55\uFF0C\u5DF2\u62D2\u7EDD\u8FDE\u63A5\u3002\u8BF7\u68C0\u67E5\u672C\u5730 SQLite \u6570\u636E\u5E93\u540E\u91CD\u8BD5\u3002");
          return false;
        }
      };
      client.connect(config);
    });
  }
  createHostKeyChallenge(profile, key) {
    const newFingerprint = `SHA256:${createHash2("sha256").update(key).digest("base64")}`;
    const trusted = this.hostKeys.get(profile.id);
    if (trusted && trusted.host === profile.host && trusted.port === profile.port && trusted.fingerprint === newFingerprint) {
      return void 0;
    }
    return {
      challengeId: randomUUID3(),
      profileId: profile.id,
      host: profile.host,
      port: profile.port,
      oldFingerprint: trusted?.fingerprint,
      newFingerprint,
      risk: trusted ? "changed" : "first_seen"
    };
  }
  async createConnectConfig(profile) {
    const config = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: profile.connectTimeoutMs,
      keepaliveInterval: profile.keepaliveIntervalMs,
      keepaliveCountMax: 3
    };
    if (profile.jumpHost) {
      throw new Error("\u7B2C\u4E00\u7248\u6682\u4E0D\u652F\u6301\u8DF3\u677F\u673A\u8FDE\u63A5\uFF0C\u8BF7\u5148\u76F4\u8FDE\u670D\u52A1\u5668");
    }
    if (profile.authMethod === "saved_password") {
      const password = await this.credentials.getSecret(profile.credentialId);
      if (!password) {
        throw new Error("\u7CFB\u7EDF\u51ED\u636E\u5E93\u4E2D\u6CA1\u6709\u627E\u5230\u4FDD\u5B58\u7684\u5BC6\u7801");
      }
      config.password = password;
      return config;
    }
    if (profile.authMethod === "private_key") {
      if (!profile.privateKeyPath) {
        throw new Error("\u79C1\u94A5\u8BA4\u8BC1\u9700\u8981\u586B\u5199\u79C1\u94A5\u8DEF\u5F84");
      }
      config.privateKey = await readFile2(profile.privateKeyPath, "utf8");
      const passphrase = await this.credentials.getSecret(profile.privateKeyPassphraseCredentialId);
      if (passphrase) {
        config.passphrase = passphrase;
      }
      return config;
    }
    if (profile.authMethod === "ssh_agent") {
      const agent = process.env.SSH_AUTH_SOCK;
      if (!agent) {
        throw new Error("\u5F53\u524D\u73AF\u5883\u6CA1\u6709\u53EF\u7528\u7684 SSH_AUTH_SOCK\uFF0C\u65E0\u6CD5\u4F7F\u7528 SSH Agent");
      }
      config.agent = agent;
      return config;
    }
    throw new Error("\u6BCF\u6B21\u8F93\u5165\u5BC6\u7801\u6A21\u5F0F\u5C1A\u672A\u63A5\u5165 GUI \u5BC6\u7801\u5F39\u7A97\uFF0C\u8BF7\u4F7F\u7528\u4FDD\u5B58\u5BC6\u7801\u6216\u79C1\u94A5");
  }
  execRaw(client, command, timeoutMs = 12e4) {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("\u8FDC\u7A0B\u547D\u4EE4\u6267\u884C\u8D85\u65F6"));
        }
      }, timeoutMs);
      client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timeout);
          reject(sanitizedError(error));
          return;
        }
        stream.on("data", (data) => {
          stdout += data.toString("utf8");
        });
        stream.stderr.on("data", (data) => {
          stderr += data.toString("utf8");
        });
        stream.on("close", (exitCode, signal) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve({ stdout, stderr, exitCode, signal });
          }
        });
      });
    });
  }
  getManaged(sessionId) {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      throw new Error(`\u8FDE\u63A5\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF1A${sessionId}`);
    }
    return managed;
  }
  findActiveProfileSession(profileId) {
    return [...this.sessions.values()].find(
      (managed) => managed.profile.id === profileId && managed.session.health !== "disconnected"
    );
  }
  findTerminal(terminalId) {
    for (const managed of this.sessions.values()) {
      const terminal = managed.terminal;
      if (terminal?.id === terminalId) return terminal;
    }
    throw new Error(`\u7EC8\u7AEF\u4E0D\u5B58\u5728\uFF1A${terminalId}`);
  }
};

// src/core/services.ts
function createCoreServices(options = {}) {
  const credentialVault = options.credentialVault ?? new CredentialVault();
  const sqliteStore = options.sqliteStore ?? new SqliteStore();
  const codrivingLedger = isCodrivingLedger(sqliteStore) && !sqliteStore.status.usingJsonFallback && !sqliteStore.status.unavailable && !sqliteStore.status.migrationBlocked ? sqliteStore : void 0;
  const profileStore = new ProfileStore(credentialVault, { sqlite: sqliteStore });
  const historyStore = new HistoryStore({ sqlite: sqliteStore });
  const hostKeyStore = new HostKeyStore(sqliteStore);
  const sessionManager = new SshSessionManager(profileStore, credentialVault, historyStore, hostKeyStore);
  let closed = false;
  return {
    credentialVault,
    sqliteStore,
    codrivingLedger,
    profileStore,
    historyStore,
    hostKeyStore,
    sessionManager,
    close: () => {
      if (closed) return;
      closed = true;
      sqliteStore.close();
    }
  };
}
function isCodrivingLedger(value) {
  const candidate = value;
  return typeof candidate.loadCodrivingState === "function" && typeof candidate.recordCodrivingAction === "function" && typeof candidate.saveCodrivingSessionState === "function" && typeof candidate.replaceRuntimeLeases === "function";
}

// src/runtime/runtime-controller.ts
import { randomUUID as randomUUID6 } from "crypto";
import { z as z2 } from "zod";

// src/core/codriving-coordinator.ts
import { createHash as createHash3, randomUUID as randomUUID4 } from "crypto";
var CodexAccessPausedError = class extends Error {
};
var CodrivingCoordinator = class {
  constructor(execution, options = {}) {
    this.execution = execution;
    this.id = options.id ?? randomUUID4;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.approvalTtlMs = options.approvalTtlMs ?? 30 * 6e4;
    this.ledger = options.ledger;
    this.restoreLedgerState();
  }
  execution;
  pendingCommands = /* @__PURE__ */ new Map();
  pendingFileTransfers = /* @__PURE__ */ new Map();
  events = [];
  trustedUntil = /* @__PURE__ */ new Map();
  authorizationLevels = /* @__PURE__ */ new Map();
  pausedCodexSessions = /* @__PURE__ */ new Set();
  actionListeners = /* @__PURE__ */ new Set();
  id;
  now;
  approvalTtlMs;
  ledger;
  nextSequence = 0;
  async requestCommand(input) {
    const pauseReason = input.actor === "codex" ? this.codexPauseReason(input.sessionId) : void 0;
    if (pauseReason) {
      const assessment2 = assessCommand(input.command);
      const action2 = this.createAction({
        sessionId: input.sessionId,
        actor: input.actor,
        kind: "command",
        status: "paused",
        risk: assessment2.risk,
        summary: redactCommand(input.command),
        reason: pauseReason,
        binding: { command: input.command }
      });
      this.recordNewAction(action2);
      return { action: { ...action2 } };
    }
    const session = this.currentSession(input.sessionId);
    const assessment = assessCommand(input.command);
    const requiresApproval = this.requiresApproval(input.actor, session.authorizationLevel, assessment.risk);
    const action = this.createAction({
      sessionId: input.sessionId,
      actor: input.actor,
      kind: "command",
      status: requiresApproval ? "pending_approval" : "queued",
      risk: assessment.risk,
      summary: redactCommand(input.command),
      reason: assessment.reason,
      approvalExpiresAt: requiresApproval ? this.approvalExpiry() : void 0,
      binding: { command: input.command }
    });
    this.recordNewAction(action);
    if (action.status === "pending_approval") {
      this.pendingCommands.set(action.id, { action, command: input.command });
      return { action: { ...action } };
    }
    try {
      const result = await this.execution.executeCommand(input.sessionId, input.command, {
        echoCommand: input.actor === "codex",
        beforeStart: () => this.startQueuedCommand(action)
      });
      this.settleExecutedAction(action, "completed");
      return { action: { ...action }, result };
    } catch (error) {
      if (error instanceof CodexAccessPausedError) {
        action.reason = error.message;
        this.updateActionStatus(action, "paused");
        return { action: { ...action } };
      }
      this.settleExecutedAction(action, "failed");
      throw error;
    }
  }
  async requestFileTransfer(input) {
    const pauseReason = input.actor === "codex" ? this.codexPauseReason(input.request.sessionId) : void 0;
    if (pauseReason) {
      const action2 = this.createAction({
        sessionId: input.request.sessionId,
        actor: input.actor,
        kind: "file_transfer",
        status: "paused",
        risk: input.request.direction === "download" ? "readonly" : "write",
        summary: input.request.direction === "download" ? "\u4E0B\u8F7D\u6587\u4EF6" : "\u4E0A\u4F20\u6587\u4EF6",
        reason: pauseReason,
        binding: input.request
      });
      this.recordNewAction(action2);
      return { action: { ...action2 } };
    }
    const session = this.currentSession(input.request.sessionId);
    const risk = input.request.direction === "download" ? "readonly" : "write";
    const reason = input.request.direction === "download" ? "\u4E0B\u8F7D\u4E0D\u4F1A\u4FEE\u6539\u8FDC\u7A0B\u670D\u52A1\u5668\u6587\u4EF6" : "\u4E0A\u4F20\u4F1A\u4FEE\u6539\u8FDC\u7A0B\u670D\u52A1\u5668\u6587\u4EF6";
    const requiresApproval = this.requiresApproval(input.actor, session.authorizationLevel, risk);
    const action = this.createAction({
      sessionId: input.request.sessionId,
      actor: input.actor,
      kind: "file_transfer",
      status: requiresApproval ? "pending_approval" : "running",
      risk,
      summary: input.request.direction === "download" ? "\u4E0B\u8F7D\u6587\u4EF6" : "\u4E0A\u4F20\u6587\u4EF6",
      reason,
      approvalExpiresAt: requiresApproval ? this.approvalExpiry() : void 0,
      binding: input.request
    });
    this.recordNewAction(action);
    if (action.status === "pending_approval") {
      this.pendingFileTransfers.set(action.id, { action, request: { ...input.request } });
      return { action: { ...action } };
    }
    try {
      const result = await this.execution.executeFileTransfer(input.request);
      this.settleExecutedAction(action, "completed");
      return { action: { ...action }, result };
    } catch (error) {
      this.settleExecutedAction(action, "failed");
      throw error;
    }
  }
  listEvents(sessionId, afterSequence = 0) {
    this.expireApprovals();
    return this.events.filter((event) => event.sessionId === sessionId && event.sequence > afterSequence).sort((left, right) => left.sequence - right.sequence).map((event) => ({ ...event }));
  }
  expireApprovals() {
    const expired = [];
    for (const [actionId, pending] of this.pendingCommands) {
      if (!this.expireIfNeeded(pending.action)) continue;
      this.pendingCommands.delete(actionId);
      expired.push({ ...pending.action });
    }
    for (const [actionId, pending] of this.pendingFileTransfers) {
      if (!this.expireIfNeeded(pending.action)) continue;
      this.pendingFileTransfers.delete(actionId);
      expired.push({ ...pending.action });
    }
    return expired;
  }
  pauseCodex(sessionId) {
    this.execution.getSession(sessionId);
    this.pausedCodexSessions.add(sessionId);
    this.persistSessionState(sessionId);
    this.appendControlEvent(sessionId, "\u7528\u6237\u5DF2\u5B8C\u5168\u63A5\u7BA1\uFF0CCodex \u65B0\u64CD\u4F5C\u5DF2\u6682\u505C");
  }
  resumeCodex(sessionId) {
    this.execution.getSession(sessionId);
    this.pausedCodexSessions.delete(sessionId);
    this.persistSessionState(sessionId);
    this.appendControlEvent(sessionId, "\u7528\u6237\u5DF2\u6062\u590D Codex \u64CD\u4F5C\u6743");
  }
  isCodexPaused(sessionId) {
    return this.pausedCodexSessions.has(sessionId);
  }
  onActionChanged(listener) {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }
  setAuthorizationLevel(input) {
    if (input.authorizationLevel === "trusted_session") {
      const expiresAt = input.trustedUntil ? new Date(input.trustedUntil) : void 0;
      if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= this.now().getTime()) {
        throw new Error("\u4FE1\u4EFB\u4F1A\u8BDD\u5FC5\u987B\u8BBE\u7F6E\u672A\u6765\u7684\u6709\u6548\u671F");
      }
      this.trustedUntil.set(input.sessionId, expiresAt.toISOString());
    } else {
      this.trustedUntil.delete(input.sessionId);
    }
    const session = this.execution.setAuthorizationLevel(input.sessionId, input.authorizationLevel);
    this.persistSessionState(input.sessionId, session.authorizationLevel);
    return session;
  }
  async approveAction(input) {
    const pending = this.pendingCommands.get(input.actionId);
    if (pending) {
      if (pending.action.digest !== input.digest) {
        throw new Error("\u5BA1\u6279\u5DF2\u5931\u6548\u6216\u4E0E\u5F85\u6267\u884C\u52A8\u4F5C\u4E0D\u5339\u914D");
      }
      if (this.expireIfNeeded(pending.action)) {
        this.pendingCommands.delete(input.actionId);
        throw new Error("\u5BA1\u6279\u5DF2\u8FC7\u671F\uFF0C\u64CD\u4F5C\u5DF2\u81EA\u52A8\u62D2\u7EDD");
      }
      this.pendingCommands.delete(input.actionId);
      this.updateActionStatus(pending.action, "queued");
      try {
        const result = await this.execution.executeCommand(pending.action.sessionId, pending.command, {
          echoCommand: pending.action.actor === "codex",
          beforeStart: () => this.startQueuedCommand(pending.action)
        });
        this.settleExecutedAction(pending.action, "completed");
        return { action: { ...pending.action }, result };
      } catch (error) {
        if (error instanceof CodexAccessPausedError) {
          pending.action.reason = error.message;
          this.updateActionStatus(pending.action, "paused");
          return { action: { ...pending.action } };
        }
        this.settleExecutedAction(pending.action, "failed");
        throw error;
      }
    }
    const pendingTransfer = this.pendingFileTransfers.get(input.actionId);
    if (!pendingTransfer || pendingTransfer.action.digest !== input.digest) {
      throw new Error("\u5BA1\u6279\u5DF2\u5931\u6548\u6216\u4E0E\u5F85\u6267\u884C\u52A8\u4F5C\u4E0D\u5339\u914D");
    }
    if (this.expireIfNeeded(pendingTransfer.action)) {
      this.pendingFileTransfers.delete(input.actionId);
      throw new Error("\u5BA1\u6279\u5DF2\u8FC7\u671F\uFF0C\u64CD\u4F5C\u5DF2\u81EA\u52A8\u62D2\u7EDD");
    }
    this.pendingFileTransfers.delete(input.actionId);
    this.updateActionStatus(pendingTransfer.action, "running");
    try {
      const result = await this.execution.executeFileTransfer(pendingTransfer.request);
      this.settleExecutedAction(pendingTransfer.action, "completed");
      return { action: { ...pendingTransfer.action }, result };
    } catch (error) {
      this.settleExecutedAction(pendingTransfer.action, "failed");
      throw error;
    }
  }
  rejectAction(input) {
    const pending = this.pendingCommands.get(input.actionId) ?? this.pendingFileTransfers.get(input.actionId);
    if (!pending || pending.action.digest !== input.digest) {
      throw new Error("\u5BA1\u6279\u5DF2\u5931\u6548\u6216\u4E0E\u5F85\u6267\u884C\u52A8\u4F5C\u4E0D\u5339\u914D");
    }
    this.pendingCommands.delete(input.actionId);
    this.pendingFileTransfers.delete(input.actionId);
    this.updateActionStatus(pending.action, "rejected");
    return { ...pending.action };
  }
  rejectAllPending(reason = "Runtime \u5DF2\u5173\u95ED\uFF0C\u5F85\u5BA1\u6279\u64CD\u4F5C\u672A\u6267\u884C") {
    const pending = [...this.pendingCommands.values(), ...this.pendingFileTransfers.values()];
    this.pendingCommands.clear();
    this.pendingFileTransfers.clear();
    return pending.map(({ action }) => {
      action.reason = reason;
      this.updateActionStatus(action, "rejected");
      return { ...action };
    });
  }
  requiresApproval(actor, authorizationLevel, risk) {
    if (actor === "user") return risk === "high";
    if (authorizationLevel === "ask_every_time") return true;
    if (authorizationLevel === "auto_readonly") return risk !== "readonly";
    return risk === "high";
  }
  currentSession(sessionId) {
    let session = this.execution.getSession(sessionId);
    const persistedLevel = this.authorizationLevels.get(sessionId);
    if (persistedLevel && persistedLevel !== session.authorizationLevel) {
      session = this.execution.setAuthorizationLevel(sessionId, persistedLevel);
    }
    const trustedUntil = this.trustedUntil.get(sessionId);
    if (session.authorizationLevel === "trusted_session" && (!trustedUntil || new Date(trustedUntil).getTime() <= this.now().getTime())) {
      this.trustedUntil.delete(sessionId);
      this.authorizationLevels.set(sessionId, "ask_every_time");
      const downgraded = this.execution.setAuthorizationLevel(sessionId, "ask_every_time");
      this.persistSessionState(sessionId, downgraded.authorizationLevel);
      return downgraded;
    }
    return session;
  }
  codexPauseReason(sessionId) {
    this.expireApprovals();
    if (this.pausedCodexSessions.has(sessionId)) {
      return "\u7528\u6237\u5DF2\u5B8C\u5168\u63A5\u7BA1\u5F53\u524D\u4F1A\u8BDD\uFF0CCodex \u65B0\u64CD\u4F5C\u5DF2\u6682\u505C";
    }
    const hasPendingApproval = [...this.pendingCommands.values(), ...this.pendingFileTransfers.values()].some((pending) => pending.action.sessionId === sessionId);
    return hasPendingApproval ? "\u5F53\u524D\u4F1A\u8BDD\u5B58\u5728\u5F85\u5BA1\u6279\u52A8\u4F5C\uFF0C\u540E\u7EED Codex \u961F\u5217\u5DF2\u6682\u505C" : void 0;
  }
  assertCodexCanStart(sessionId) {
    if (this.pausedCodexSessions.has(sessionId)) {
      throw new CodexAccessPausedError("\u7528\u6237\u5DF2\u5B8C\u5168\u63A5\u7BA1\u5F53\u524D\u4F1A\u8BDD\uFF0C\u6392\u961F\u4E2D\u7684 Codex \u64CD\u4F5C\u672A\u6267\u884C");
    }
  }
  startQueuedCommand(action) {
    if (action.actor === "codex") this.assertCodexCanStart(action.sessionId);
    this.updateActionStatus(action, "running");
  }
  approvalExpiry() {
    return new Date(this.now().getTime() + this.approvalTtlMs).toISOString();
  }
  expireIfNeeded(action) {
    if (!action.approvalExpiresAt || new Date(action.approvalExpiresAt).getTime() > this.now().getTime()) {
      return false;
    }
    this.updateActionStatus(action, "expired");
    return true;
  }
  updateActionStatus(action, status) {
    action.status = status;
    action.sequence = ++this.nextSequence;
    action.updatedAt = this.now().toISOString();
    let persistenceError;
    try {
      this.ledger?.recordCodrivingAction({ ...action });
    } catch (error) {
      persistenceError = error;
    }
    this.notifyActionChanged(action);
    if (persistenceError) throw persistenceError;
  }
  settleExecutedAction(action, status) {
    try {
      this.updateActionStatus(action, status);
    } catch {
      action.reason = `${action.reason}\uFF1B\u672C\u5730\u5171\u9A7E\u8D26\u672C\u5199\u5165\u5931\u8D25\uFF0C\u8BF7\u52FF\u636E\u6B64\u91CD\u590D\u6267\u884C\u64CD\u4F5C`;
      this.notifyActionChanged(action);
    }
  }
  recordNewAction(action) {
    this.events.push(action);
    this.ledger?.recordCodrivingAction({ ...action });
    this.notifyActionChanged(action);
  }
  notifyActionChanged(action) {
    for (const listener of this.actionListeners) {
      try {
        listener({ ...action });
      } catch {
      }
    }
  }
  persistSessionState(sessionId, authorizationLevel) {
    const level = authorizationLevel ?? this.execution.getSession(sessionId).authorizationLevel;
    this.authorizationLevels.set(sessionId, level);
    this.ledger?.saveCodrivingSessionState({
      sessionId,
      authorizationLevel: level,
      trustedUntil: this.trustedUntil.get(sessionId),
      codexPaused: this.pausedCodexSessions.has(sessionId),
      updatedAt: this.now().toISOString()
    });
  }
  restoreLedgerState() {
    if (!this.ledger) return;
    const snapshot = this.ledger.loadCodrivingState();
    const latestActions = /* @__PURE__ */ new Map();
    for (const action of snapshot.actions) {
      this.nextSequence = Math.max(this.nextSequence, action.sequence);
      const existing = latestActions.get(action.id);
      if (!existing || action.sequence > existing.sequence) latestActions.set(action.id, { ...action });
    }
    this.events.push(...latestActions.values());
    for (const state of snapshot.sessions) {
      this.authorizationLevels.set(state.sessionId, state.authorizationLevel);
      if (state.codexPaused) this.pausedCodexSessions.add(state.sessionId);
      if (state.trustedUntil) this.trustedUntil.set(state.sessionId, state.trustedUntil);
    }
    for (const action of this.events) {
      if (action.status !== "pending_approval" && action.status !== "queued" && action.status !== "running") continue;
      action.reason = `${action.reason}\uFF1BRuntime \u5DF2\u91CD\u65B0\u542F\u52A8\uFF0C\u672A\u81EA\u52A8\u91CD\u653E\u8BE5\u64CD\u4F5C`;
      this.updateActionStatus(action, "interrupted");
    }
  }
  appendControlEvent(sessionId, summary) {
    this.recordNewAction(this.createAction({
      sessionId,
      actor: "system",
      kind: "control",
      status: "completed",
      risk: "readonly",
      summary,
      reason: summary
    }));
  }
  createAction(input) {
    const { binding, ...visible } = input;
    const id = this.id();
    const sequence = ++this.nextSequence;
    const timestamp = this.now().toISOString();
    const digest = createHash3("sha256").update(JSON.stringify({
      id,
      sessionId: visible.sessionId,
      sequence,
      actor: visible.actor,
      kind: visible.kind,
      risk: visible.risk,
      binding: binding ?? visible.summary
    })).digest("hex");
    return { ...visible, id, sequence, digest, createdAt: timestamp, updatedAt: timestamp };
  }
};

// src/core/profile-portability.ts
import { randomUUID as randomUUID5 } from "crypto";
import { mkdir as mkdir2, readFile as readFile3, rm, writeFile as writeFile2 } from "fs/promises";
import path6 from "path";
function portableProfile(profile) {
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
function profileIdentity(profile) {
  return JSON.stringify([profile.name, profile.host, profile.port, profile.username]);
}
var ProfilePortabilityService = class {
  constructor(profiles, credentials, dataDir = resolveAppDataDir()) {
    this.profiles = profiles;
    this.credentials = credentials;
    this.dataDir = dataDir;
  }
  profiles;
  credentials;
  dataDir;
  async createExport(includesSecrets) {
    const profiles = await this.profiles.list();
    const portableProfiles = await Promise.all(profiles.map(async (profile) => {
      const portable = portableProfile(profile);
      if (!includesSecrets) return portable;
      const password = await this.credentials.getSecret(profile.credentialId);
      const privateKeyPassphrase = await this.credentials.getSecret(profile.privateKeyPassphraseCredentialId);
      let privateKeyContent;
      let privateKeyFileName;
      if (profile.authMethod === "private_key" && profile.privateKeyPath) {
        try {
          privateKeyContent = await readFile3(profile.privateKeyPath, "utf8");
          privateKeyFileName = path6.basename(profile.privateKeyPath);
        } catch {
          throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u201C${profile.name}\u201D\u7684\u79C1\u94A5\u6587\u4EF6\uFF0C\u5DF2\u505C\u6B62\u5B8C\u6574\u5BFC\u51FA`);
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
      format: "orbitssh-connections",
      version: 1,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      includesSecrets,
      profiles: portableProfiles
    };
  }
  async importDocument(document) {
    const existing = await this.profiles.list();
    const identities = new Set(existing.map(profileIdentity));
    const importedIds = [];
    const importedKeyPaths = [];
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
          const keyDirectory = path6.join(this.dataDir, "imported-keys");
          await mkdir2(keyDirectory, { recursive: true });
          const safeName = path6.basename(portable.credentials.privateKeyFileName).replace(/[^A-Za-z0-9._-]/g, "_") || "private-key";
          privateKeyPath = path6.join(keyDirectory, `${randomUUID5()}-${safeName}`);
          await writeFile2(privateKeyPath, portable.credentials.privateKeyContent, {
            encoding: "utf8",
            mode: 384,
            flag: "wx"
          });
          importedKeyPaths.push(privateKeyPath);
        }
        const input = {
          name: portable.name,
          host: portable.host,
          port: portable.port,
          username: portable.username,
          authMethod: portable.authMethod === "password_prompt" ? "saved_password" : portable.authMethod,
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
        }
      }
      await Promise.all(importedKeyPaths.map(async (keyPath) => {
        try {
          await rm(keyPath, { force: true });
        } catch {
        }
      }));
      throw error;
    }
    return { importedCount: importedIds.length, skippedCount };
  }
};

// src/runtime/runtime-lifetime.ts
var RuntimeLifetime = class {
  clients = /* @__PURE__ */ new Map();
  sessions = /* @__PURE__ */ new Set();
  retainedSessions = /* @__PURE__ */ new Set();
  activeActions = /* @__PURE__ */ new Set();
  exitPolicy = "close_all";
  desktopExitRequested = false;
  attachClient(client) {
    this.clients.set(client.id, client.kind);
  }
  detachClient(clientId) {
    this.clients.delete(clientId);
  }
  registerSession(sessionId) {
    this.sessions.add(sessionId);
  }
  removeSession(sessionId) {
    this.sessions.delete(sessionId);
    this.retainedSessions.delete(sessionId);
  }
  retainSession(sessionId) {
    this.sessions.add(sessionId);
    this.retainedSessions.add(sessionId);
  }
  releaseSession(sessionId) {
    this.retainedSessions.delete(sessionId);
  }
  beginAction(actionId) {
    this.activeActions.add(actionId);
  }
  finishAction(actionId) {
    this.activeActions.delete(actionId);
  }
  setDesktopExitPolicy(policy) {
    this.exitPolicy = policy;
    this.desktopExitRequested = true;
  }
  listLeases(updatedAt = (/* @__PURE__ */ new Date()).toISOString()) {
    return [
      ...[...this.clients].map(([id, kind]) => ({ kind, id, updatedAt })),
      ...[...this.activeActions].map((id) => ({ kind: "active_action", id, updatedAt })),
      ...[...this.retainedSessions].map((id) => ({ kind: "retained_session", id, updatedAt }))
    ];
  }
  snapshot() {
    const desktopAttached = [...this.clients.values()].includes("desktop");
    const mcpClientCount = [...this.clients.values()].filter((kind) => kind === "mcp").length;
    const noClients = this.clients.size === 0;
    const keepForRetainedSession = this.exitPolicy === "keep_codex" && this.retainedSessions.size > 0;
    const keepForActiveAction = this.exitPolicy !== "close_all" && this.activeActions.size > 0;
    const desktopGone = this.desktopExitRequested && !desktopAttached;
    const forceClose = desktopGone && this.exitPolicy === "close_all";
    const finishThenExit = desktopGone && this.exitPolicy === "finish_then_exit" && this.activeActions.size === 0;
    const shouldShutdown = forceClose || finishThenExit || noClients && !keepForRetainedSession && !keepForActiveAction;
    return {
      shouldShutdown,
      retainedSessionIds: [...this.retainedSessions],
      sessionIdsToClose: shouldShutdown || this.exitPolicy === "close_all" ? [...this.sessions] : [],
      activeActionCount: this.activeActions.size,
      desktopAttached,
      mcpClientCount,
      exitPolicy: this.exitPolicy
    };
  }
};

// src/runtime/runtime-controller.ts
var idSchema = z2.string().min(1);
var sessionRequestSchema = z2.object({ sessionId: idSchema }).strict();
var openSessionSchema = z2.object({
  profileId: idSchema,
  authorizationLevel: authorizationLevelSchema.optional()
}).strict();
var commandRequestSchema = z2.object({
  sessionId: idSchema,
  command: z2.string().min(1),
  // actor 可能由旧客户端传入，但 Runtime 永远忽略它并根据连接身份决定来源。
  actor: z2.unknown().optional()
}).strict();
var terminalWriteSchema = z2.object({ sessionId: idSchema, terminalId: idSchema, data: z2.string() }).strict();
var terminalSubmitSchema = z2.object({
  sessionId: idSchema,
  terminalId: idSchema,
  command: z2.string().trim().min(1).max(32768)
}).strict();
var actionListSchema = z2.object({ sessionId: idSchema, afterSequence: z2.number().int().min(0).optional() }).strict();
var exitPolicySchema = z2.object({
  policy: z2.enum(["keep_codex", "finish_then_exit", "close_all"])
}).strict();
var MCP_METHODS = /* @__PURE__ */ new Set([
  "profiles:list",
  "sessions:list",
  "sessions:open",
  "sessions:health",
  "commands:request",
  "history:list",
  "files:request",
  "files:list-remote",
  "codriving:events",
  "runtime:snapshot"
]);
var RuntimeController = class {
  constructor(options) {
    this.options = options;
    this.services = options.services;
    this.coordinator = options.coordinator ?? new CodrivingCoordinator(options.services.sessionManager, {
      ledger: options.services.codrivingLedger
    });
    this.lifetime = options.lifetime ?? new RuntimeLifetime();
    this.portability = options.portability ?? new ProfilePortabilityService(
      options.services.profileStore,
      options.services.credentialVault
    );
    this.unsubscribeActionUpdates = this.coordinator.onActionChanged((action) => this.emitAction(action));
    this.services.sessionManager.on("terminal-data", (chunk) => {
      this.options.emit?.("terminal:data", chunk);
    });
    this.services.sessionManager.on("session-updated", (session) => {
      this.options.emit?.("session:updated", session);
    });
    this.approvalTimer = setInterval(() => this.expireApprovals(), 1e3);
    this.approvalTimer.unref();
  }
  options;
  services;
  coordinator;
  lifetime;
  portability;
  unsubscribeActionUpdates;
  pendingActionLeases = /* @__PURE__ */ new Set();
  approvalTimer;
  clientConnected(context) {
    this.lifetime.attachClient({ id: context.clientId, kind: context.kind });
    this.emitRuntimeState();
  }
  clientDisconnected(context) {
    this.lifetime.detachClient(context.clientId);
    this.emitRuntimeState();
    if (context.kind === "desktop" && !this.lifetime.snapshot().desktopAttached && this.pendingActionLeases.size > 0) {
      try {
        this.options.notifier?.notifyPendingApproval();
      } catch {
      }
    }
    if (this.lifetime.snapshot().shouldShutdown) this.options.requestShutdown?.();
  }
  shouldShutdown() {
    return this.lifetime.snapshot().shouldShutdown;
  }
  async handle(method, params, context) {
    this.assertMethodAllowed(method, context);
    switch (method) {
      case "profiles:list":
        return this.services.profileStore.list();
      case "profiles:save": {
        const input = z2.object({ input: profileInputSchema, id: idSchema.optional() }).strict().parse(params);
        if (input.id) this.services.sessionManager.assertProfileCanBeUpdated(input.id, input.input);
        const profile = await this.services.profileStore.save(input.input, input.id);
        this.services.sessionManager.discardHostKeyChallenge(profile.id);
        this.options.emit?.("profiles:updated", await this.services.profileStore.list());
        return profile;
      }
      case "profiles:delete": {
        const { profileId } = z2.object({ profileId: idSchema }).strict().parse(params);
        this.services.sessionManager.assertProfileCanBeDeleted(profileId);
        await this.services.profileStore.delete(profileId);
        this.services.sessionManager.discardHostKeyChallenge(profileId);
        this.options.emit?.("profiles:updated", await this.services.profileStore.list());
        return { ok: true };
      }
      case "profiles:export-document": {
        const { includesSecrets } = z2.object({ includesSecrets: z2.boolean() }).strict().parse(params);
        return this.portability.createExport(includesSecrets);
      }
      case "profiles:import-document": {
        const { document } = z2.object({ document: profileExportDocumentSchema }).strict().parse(params);
        const result = await this.portability.importDocument(document);
        this.options.emit?.("profiles:updated", await this.services.profileStore.list());
        return result;
      }
      case "sessions:list":
        return this.services.sessionManager.listSessions();
      case "sessions:open": {
        const input = openSessionSchema.parse(params);
        const authorizationLevel = context.kind === "desktop" ? input.authorizationLevel : void 0;
        let session = await this.services.sessionManager.openSession(input.profileId, authorizationLevel);
        if (context.kind === "desktop" && input.authorizationLevel) {
          session = this.coordinator.setAuthorizationLevel({
            sessionId: session.id,
            authorizationLevel: input.authorizationLevel,
            trustedUntil: input.authorizationLevel === "trusted_session" ? new Date(Date.now() + 60 * 6e4).toISOString() : void 0
          });
        }
        this.lifetime.registerSession(session.id);
        this.options.emit?.("session:updated", session);
        this.emitRuntimeState();
        return session;
      }
      case "host-keys:pending":
        return this.services.sessionManager.listHostKeyTrustChallenges();
      case "host-keys:confirm": {
        const confirmation = hostKeyTrustConfirmationSchema.parse(params);
        await this.services.sessionManager.confirmHostKeyTrust(confirmation);
        return { ok: true };
      }
      case "sessions:close": {
        const { sessionId } = sessionRequestSchema.parse(params);
        await this.services.sessionManager.closeSession(sessionId);
        this.lifetime.removeSession(sessionId);
        this.options.emit?.("session:closed", { sessionId });
        this.emitRuntimeState();
        return { ok: true };
      }
      case "sessions:health": {
        const { sessionId } = sessionRequestSchema.parse(params);
        return this.services.sessionManager.getHealth(sessionId);
      }
      case "commands:request": {
        const input = commandRequestSchema.parse(params);
        return this.trackAction(() => this.coordinator.requestCommand({
          sessionId: input.sessionId,
          actor: context.kind === "mcp" ? "codex" : "user",
          command: input.command
        }));
      }
      case "history:list": {
        const input = z2.object({ sessionId: idSchema.optional() }).strict().parse(params);
        return this.services.historyStore.list(input.sessionId);
      }
      case "files:request": {
        const request = fileTransferSchema.parse(params);
        return this.trackAction(() => this.coordinator.requestFileTransfer({
          actor: context.kind === "mcp" ? "codex" : "user",
          request
        }));
      }
      case "files:list-remote": {
        const input = remoteDirectoryRequestSchema.parse(params);
        return this.services.sessionManager.listRemoteDirectory(input.sessionId, input.remotePath);
      }
      case "terminal:open": {
        const { sessionId } = sessionRequestSchema.parse(params);
        const terminalId = await this.services.sessionManager.openTerminal(sessionId);
        return { terminalId, replay: this.services.sessionManager.getTerminalReplay(terminalId) };
      }
      case "terminal:write": {
        const input = terminalWriteSchema.parse(params);
        if (this.services.sessionManager.getTerminalSessionId(input.terminalId) !== input.sessionId) {
          throw new Error("\u7EC8\u7AEF\u4E0E\u8FDE\u63A5\u4F1A\u8BDD\u4E0D\u5339\u914D");
        }
        this.services.sessionManager.writeTerminal(input.terminalId, input.data);
        return { ok: true };
      }
      case "terminal:submit": {
        const input = terminalSubmitSchema.parse(params);
        if (this.services.sessionManager.getTerminalSessionId(input.terminalId) !== input.sessionId) {
          throw new Error("\u7EC8\u7AEF\u4E0E\u8FDE\u63A5\u4F1A\u8BDD\u4E0D\u5339\u914D");
        }
        return this.trackAction(() => this.coordinator.requestCommand({
          sessionId: input.sessionId,
          actor: "user",
          command: input.command
        }));
      }
      case "terminal:close": {
        const { terminalId } = z2.object({ terminalId: idSchema }).strict().parse(params);
        this.services.sessionManager.closeTerminal(terminalId);
        return { ok: true };
      }
      case "codriving:events": {
        const input = actionListSchema.parse(params);
        return this.coordinator.listEvents(input.sessionId, input.afterSequence);
      }
      case "codriving:approve": {
        const approval = codrivingApprovalSchema.parse(params);
        try {
          return await this.trackAction(() => this.coordinator.approveAction(approval));
        } finally {
          this.releasePendingAction(approval.actionId);
        }
      }
      case "codriving:reject": {
        const approval = codrivingApprovalSchema.parse(params);
        const action = this.coordinator.rejectAction(approval);
        this.releasePendingAction(approval.actionId);
        return action;
      }
      case "codriving:pause": {
        const { sessionId } = sessionRequestSchema.parse(params);
        this.coordinator.pauseCodex(sessionId);
        return { ok: true };
      }
      case "codriving:resume": {
        const { sessionId } = sessionRequestSchema.parse(params);
        this.coordinator.resumeCodex(sessionId);
        return { ok: true };
      }
      case "codriving:paused": {
        const { sessionId } = sessionRequestSchema.parse(params);
        return this.coordinator.isCodexPaused(sessionId);
      }
      case "codriving:set-authorization": {
        const session = this.coordinator.setAuthorizationLevel(sessionAuthorizationChangeSchema.parse(params));
        this.options.emit?.("session:updated", session);
        return session;
      }
      case "runtime:set-exit-policy": {
        const { policy } = exitPolicySchema.parse(params);
        await this.setExitPolicy(policy);
        return this.lifetime.snapshot();
      }
      case "runtime:snapshot":
        return this.lifetime.snapshot();
      default:
        throw new Error(`\u672A\u77E5 Runtime \u65B9\u6CD5\uFF1A${method}`);
    }
  }
  async close() {
    clearInterval(this.approvalTimer);
    this.unsubscribeActionUpdates();
    for (const session of this.services.sessionManager.listSessions()) {
      try {
        await this.services.sessionManager.closeSession(session.id);
      } catch {
      }
    }
    this.services.codrivingLedger?.replaceRuntimeLeases([]);
    this.services.close();
  }
  assertMethodAllowed(method, context) {
    if (context.kind === "mcp" && !MCP_METHODS.has(method)) {
      throw new Error(`MCP \u5BA2\u6237\u7AEF\u65E0\u6743\u8C03\u7528 Runtime \u65B9\u6CD5\uFF1A${method}`);
    }
  }
  async trackAction(operation) {
    const leaseId = randomUUID6();
    this.lifetime.beginAction(leaseId);
    this.emitRuntimeState();
    try {
      const result = await operation();
      if (result.action.status === "pending_approval") {
        this.rememberPendingAction(result.action.id);
        if (!this.lifetime.snapshot().desktopAttached) {
          try {
            this.options.notifier?.notifyPendingApproval();
          } catch {
          }
        }
      }
      return result;
    } finally {
      this.lifetime.finishAction(leaseId);
      this.emitRuntimeState();
      if (this.lifetime.snapshot().shouldShutdown) this.options.requestShutdown?.();
    }
  }
  async setExitPolicy(policy) {
    const sessions = this.services.sessionManager.listSessions();
    if (policy === "keep_codex") {
      for (const session of sessions) this.lifetime.retainSession(session.id);
    } else {
      for (const session of sessions) this.lifetime.releaseSession(session.id);
    }
    this.lifetime.setDesktopExitPolicy(policy);
    this.emitRuntimeState();
    if (policy === "close_all") {
      for (const action of this.coordinator.rejectAllPending()) {
        this.releasePendingAction(action.id);
      }
      for (const session of sessions) {
        await this.services.sessionManager.closeSession(session.id);
        this.lifetime.removeSession(session.id);
      }
      this.options.requestShutdown?.();
    }
  }
  emitAction(action) {
    this.options.emit?.("codriving:action-updated", action);
  }
  emitRuntimeState() {
    const snapshot = this.lifetime.snapshot();
    this.services.codrivingLedger?.replaceRuntimeLeases(this.lifetime.listLeases());
    this.options.emit?.("runtime:state", snapshot);
  }
  rememberPendingAction(actionId) {
    if (this.pendingActionLeases.has(actionId)) return;
    this.pendingActionLeases.add(actionId);
    this.lifetime.beginAction(actionId);
    this.emitRuntimeState();
  }
  releasePendingAction(actionId) {
    if (!this.pendingActionLeases.delete(actionId)) return;
    this.lifetime.finishAction(actionId);
    this.emitRuntimeState();
    if (this.lifetime.snapshot().shouldShutdown) this.options.requestShutdown?.();
  }
  expireApprovals() {
    for (const action of this.coordinator.expireApprovals()) {
      this.releasePendingAction(action.id);
    }
  }
};

// src/runtime/runtime-endpoint.ts
import { createHash as createHash4 } from "crypto";
import os2 from "os";
import path7 from "path";
function resolveRuntimeEndpoint() {
  if (process.env.ORBITSSH_RUNTIME_ENDPOINT) return process.env.ORBITSSH_RUNTIME_ENDPOINT;
  const identity = `${os2.homedir()}\0${os2.userInfo().username}`;
  const suffix = createHash4("sha256").update(identity).digest("hex").slice(0, 16);
  return process.platform === "win32" ? `\\\\.\\pipe\\orbitssh-runtime-${suffix}` : path7.join(os2.tmpdir(), `orbitssh-runtime-${suffix}.sock`);
}

// src/runtime/runtime-rpc.ts
import { randomUUID as randomUUID7 } from "crypto";
import { EventEmitter as EventEmitter2 } from "events";
import net from "net";
var MAX_FRAME_BYTES = 1024 * 1024;
function encode(frame) {
  return `${JSON.stringify(frame)}
`;
}
function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function parseFrames(buffer) {
  if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) throw new Error("Runtime \u6D88\u606F\u8D85\u8FC7\u5927\u5C0F\u9650\u5236");
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const frames = lines.filter(Boolean).map((line) => JSON.parse(line));
  return { frames, rest };
}
var RuntimeRpcServer = class {
  constructor(options) {
    this.options = options;
  }
  options;
  server;
  sockets = /* @__PURE__ */ new Set();
  contexts = /* @__PURE__ */ new Map();
  async start() {
    if (this.server) return;
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server?.once("error", onError);
      this.server?.once("listening", onListening);
      this.server?.listen(this.options.endpoint);
    });
  }
  async stop() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.contexts.clear();
    const server = this.server;
    this.server = void 0;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }
  broadcast(name, data) {
    const frame = encode({ type: "event", name, data });
    for (const socket of this.sockets) {
      if (this.contexts.has(socket) && socket.writable) socket.write(frame);
    }
  }
  accept(socket) {
    this.sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      try {
        const parsed = parseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) void this.receive(socket, frame);
      } catch {
        socket.destroy();
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      const context = this.contexts.get(socket);
      this.contexts.delete(socket);
      if (context) this.options.onClientDisconnected?.(context);
    });
  }
  async receive(socket, frame) {
    if (!this.contexts.has(socket)) {
      if (frame.type !== "hello" || frame.protocol !== 1 || !frame.clientId || !["desktop", "mcp"].includes(frame.kind)) {
        socket.destroy();
        return;
      }
      if (frame.authToken !== this.options.authTokens[frame.kind]) {
        socket.destroy();
        return;
      }
      const context = { clientId: frame.clientId, kind: frame.kind };
      this.contexts.set(socket, context);
      this.options.onClientConnected?.(context);
      socket.write(encode({ type: "hello-ack", protocol: 1 }));
      return;
    }
    if (frame.type !== "request") return;
    try {
      const result = await this.options.handle(frame.method, frame.params, this.contexts.get(socket));
      socket.write(encode({ type: "response", id: frame.id, ok: true, result }));
    } catch (error) {
      socket.write(encode({ type: "response", id: frame.id, ok: false, error: safeError(error) }));
    }
  }
};

// src/runtime/runtime-notifier.ts
import { spawn } from "child_process";
var WindowsApprovalNotifier = class {
  notifyPendingApproval() {
    if (process.platform !== "win32") return;
    const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>OrbitSSH \u7B49\u5F85\u6279\u51C6</text><text>\u4E00\u4E2A\u670D\u52A1\u5668\u4F1A\u8BDD\u6709\u53D7\u63A7\u64CD\u4F5C\u7B49\u5F85\u5904\u7406\uFF0C\u8BF7\u6253\u5F00 OrbitSSH \u67E5\u770B\u8BE6\u60C5\u3002</text></binding></visual></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OrbitSSH').Show($toast)
`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encoded
    ], {
      windowsHide: true,
      detached: true,
      stdio: "ignore"
    });
    child.on("error", () => void 0);
    child.unref();
  }
};

// src/runtime/runtime-host.ts
var RuntimeHost = class {
  endpoint;
  server;
  controller;
  stopping;
  constructor(options) {
    this.endpoint = options.endpoint ?? resolveRuntimeEndpoint();
    let shutdownQueued = false;
    const requestShutdown = () => {
      if (shutdownQueued) return;
      shutdownQueued = true;
      setTimeout(() => {
        shutdownQueued = false;
        if (!this.controller?.shouldShutdown()) return;
        void this.stop().finally(() => options.onShutdown?.());
      }, 0);
    };
    this.server = new RuntimeRpcServer({
      endpoint: this.endpoint,
      authTokens: options.authTokens,
      handle: (method, params, context) => this.requireController().handle(method, params, context),
      onClientConnected: (context) => this.requireController().clientConnected(context),
      onClientDisconnected: (context) => this.requireController().clientDisconnected(context)
    });
    this.initializeController = () => {
      const services = options.services ?? createCoreServices();
      this.controller = new RuntimeController({
        services,
        notifier: options.notifier ?? new WindowsApprovalNotifier(),
        emit: (name, data) => this.server.broadcast(name, data),
        requestShutdown
      });
    };
  }
  initializeController;
  async start() {
    if (this.controller) return;
    await this.server.start();
    try {
      this.initializeController();
    } catch (error) {
      await this.server.stop();
      throw error;
    }
  }
  stop() {
    if (!this.stopping) {
      this.stopping = (async () => {
        await this.server.stop();
        await this.controller?.close();
      })();
    }
    return this.stopping;
  }
  requireController() {
    if (!this.controller) throw new Error("OrbitSSH Runtime \u6B63\u5728\u521D\u59CB\u5316");
    return this.controller;
  }
};

// src/runtime/runtime-auth.ts
import { randomBytes } from "crypto";
import { chmod, mkdir as mkdir3, readFile as readFile4, writeFile as writeFile3 } from "fs/promises";
import path8 from "path";
var TOKEN_PATTERN = /^[a-f0-9]{64}$/;
async function loadRuntimeAuthToken(kind, dataDir = resolveAppDataDir()) {
  await mkdir3(dataDir, { recursive: true });
  const tokenPath = path8.join(dataDir, `orbitssh-runtime-${kind}.token`);
  try {
    return validateToken(await readFile4(tokenPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile3(tokenPath, `${token}
`, { encoding: "utf8", mode: 384, flag: "wx" });
    try {
      await chmod(tokenPath, 384);
    } catch {
    }
    return token;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return validateToken(await readFile4(tokenPath, "utf8"));
  }
}
async function loadRuntimeAuthTokens(dataDir = resolveAppDataDir()) {
  const [desktop, mcp] = await Promise.all([
    loadRuntimeAuthToken("desktop", dataDir),
    loadRuntimeAuthToken("mcp", dataDir)
  ]);
  return { desktop, mcp };
}
function validateToken(value) {
  const token = value.trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error("OrbitSSH Runtime \u8EAB\u4EFD\u4EE4\u724C\u683C\u5F0F\u65E0\u6548");
  return token;
}

// src/runtime/host-entry.ts
var host = new RuntimeHost({
  authTokens: await loadRuntimeAuthTokens(),
  endpoint: process.env.ORBITSSH_RUNTIME_ENDPOINT,
  onShutdown: () => process.exit(0)
});
try {
  await host.start();
} catch (error) {
  if (error.code === "EADDRINUSE") {
    process.exit(0);
  }
  throw error;
}
var stopping = false;
var stop = () => {
  if (stopping) return;
  stopping = true;
  void host.stop().finally(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
