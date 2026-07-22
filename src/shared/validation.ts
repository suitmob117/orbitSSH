import { z } from 'zod';

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
  privateKeyPath: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
  rememberPrivateKeyPassphrase: z.boolean().optional(),
  connectTimeoutMs: z.number().int().min(1000).max(120000),
  keepaliveIntervalMs: z.number().int().min(5000).max(300000),
  jumpHost: z.string().optional()
});

export const fileTransferSchema = z.object({
  sessionId: z.string().min(1),
  localPath: z.string().min(1),
  remotePath: z.string().min(1),
  direction: z.enum(['upload', 'download'])
});
