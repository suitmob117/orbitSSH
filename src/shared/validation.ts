import { z } from 'zod';

const optionalTrimmedString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional()
);

const optionalTrimmedStringArray = z.preprocess(
  (value) => Array.isArray(value)
    ? value
      .map((item) => typeof item === 'string' ? item.trim() : item)
      .filter((item) => item !== '')
    : value,
  z.array(z.string().trim().min(1)).optional()
);

export const connectionProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  authMethod: z.enum(['saved_password', 'password_prompt', 'ssh_agent', 'private_key']),
  privateKeyPath: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(),
  privateKeyPassphraseCredentialId: z.string().min(1).optional(),
  connectTimeoutMs: z.number().int().min(1000).max(120000),
  keepaliveIntervalMs: z.number().int().min(5000).max(300000),
  jumpHost: z.string().min(1).optional(),
  localTransferRoot: z.string().trim().min(1).optional(),
  remoteTransferRoots: z.array(z.string().trim().min(1)).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const commandRecordSchema = z.object({
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

export const authorizationLevelSchema = z.enum(['ask_every_time', 'auto_readonly', 'trusted_session']);

export const codrivingActionSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().min(1),
  actor: z.enum(['user', 'codex', 'system']),
  kind: z.enum(['command', 'file_transfer', 'control']),
  status: z.enum([
    'pending_approval',
    'queued',
    'running',
    'completed',
    'failed',
    'rejected',
    'expired',
    'interrupted',
    'paused'
  ]),
  risk: z.enum(['readonly', 'write', 'high']),
  summary: z.string(),
  reason: z.string(),
  approvalExpiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const codrivingSessionStateSchema = z.object({
  sessionId: z.string().min(1),
  authorizationLevel: authorizationLevelSchema,
  trustedUntil: z.string().datetime().optional(),
  codexPaused: z.boolean(),
  updatedAt: z.string().datetime()
});

export const runtimeLeaseRecordSchema = z.object({
  kind: z.enum(['desktop', 'mcp', 'active_action', 'retained_session']),
  id: z.string().min(1),
  updatedAt: z.string().datetime()
});

export const codrivingApprovalSchema = z.object({
  actionId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
});

export const sessionAuthorizationChangeSchema = z.object({
  sessionId: z.string().min(1),
  authorizationLevel: authorizationLevelSchema,
  trustedUntil: z.string().datetime().optional()
}).superRefine((change, context) => {
  if (change.authorizationLevel === 'trusted_session' && !change.trustedUntil) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '信任会话必须设置有效期',
      path: ['trustedUntil']
    });
  }
});

export const hostKeyTrustChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  profileId: z.string().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  oldFingerprint: z.string().min(1).optional(),
  newFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
  risk: z.enum(['first_seen', 'changed'])
});

export const hostKeyTrustConfirmationSchema = z.object({
  profileId: z.string().min(1),
  challengeId: z.string().uuid()
});

export const trustedHostKeySchema = hostKeyTrustChallengeSchema.pick({
  profileId: true,
  host: true,
  port: true
}).extend({
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
  trustedAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const profileInputSchema = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  authMethod: z.enum(['saved_password', 'password_prompt', 'ssh_agent', 'private_key']),
  password: z.string().optional(),
  privateKeyPath: optionalTrimmedString,
  privateKeyPassphrase: z.string().optional(),
  rememberPrivateKeyPassphrase: z.boolean().optional(),
  connectTimeoutMs: z.number().int().min(1000).max(120000),
  keepaliveIntervalMs: z.number().int().min(5000).max(300000),
  jumpHost: optionalTrimmedString,
  localTransferRoot: optionalTrimmedString,
  remoteTransferRoots: optionalTrimmedStringArray
});

export const fileTransferSchema = z.object({
  sessionId: z.string().min(1),
  localPath: z.string().min(1),
  remotePath: z.string().min(1),
  direction: z.enum(['upload', 'download'])
});

export const remoteDirectoryRequestSchema = z.object({
  sessionId: z.string().min(1),
  remotePath: z.string().min(1)
});

export const portableProfileCredentialsSchema = z.object({
  password: z.string().min(1).max(4096).optional(),
  privateKeyFileName: z.string().min(1).max(255).optional(),
  privateKeyContent: z.string().min(1).max(2_000_000).optional(),
  privateKeyPassphrase: z.string().min(1).max(4096).optional()
}).strict().refine(
  (credentials) => Boolean(credentials.privateKeyFileName) === Boolean(credentials.privateKeyContent),
  { message: '私钥文件名和内容必须同时提供' }
);

export const portableConnectionProfileSchema = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1),
  authMethod: z.enum(['saved_password', 'password_prompt', 'ssh_agent', 'private_key']),
  privateKeyPath: optionalTrimmedString,
  connectTimeoutMs: z.number().int().min(1000).max(120000),
  keepaliveIntervalMs: z.number().int().min(5000).max(300000),
  jumpHost: optionalTrimmedString,
  localTransferRoot: optionalTrimmedString,
  remoteTransferRoots: optionalTrimmedStringArray,
  credentials: portableProfileCredentialsSchema.optional()
}).strict().superRefine((profile, context) => {
  if (profile.credentials?.password && profile.authMethod !== 'saved_password') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '密码只能用于保存密码认证配置',
      path: ['credentials', 'password']
    });
  }
  const hasPrivateKeySecret = Boolean(
    profile.credentials?.privateKeyContent || profile.credentials?.privateKeyPassphrase
  );
  if (hasPrivateKeySecret && profile.authMethod !== 'private_key') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '私钥凭据只能用于私钥认证配置',
      path: ['credentials']
    });
  }
});

export const profileExportDocumentSchema = z.object({
  format: z.literal('orbitssh-connections'),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  includesSecrets: z.boolean(),
  profiles: z.array(portableConnectionProfileSchema).max(1000)
}).strict().superRefine((document, context) => {
  if (!document.includesSecrets && document.profiles.some((profile) => profile.credentials)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '安全导出文件不能包含凭据',
      path: ['profiles']
    });
  }
});
