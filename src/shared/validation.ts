import { z } from 'zod';

export const authorizationLevelSchema = z.enum(['ask_every_time', 'auto_readonly', 'trusted_session']);

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
