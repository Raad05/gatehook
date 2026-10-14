import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default('127.0.0.1'),
  /** `postgres://...`, or `pglite://memory` / `pglite://<dir>` for embedded Postgres. */
  DATABASE_URL: z.string().default('pglite://.pglite'),
  RPC_URL: z.string().default('http://127.0.0.1:8899'),
  WS_URL: z.string().default('ws://127.0.0.1:8900'),
  /** Oracle keypair JSON path; must match `Registry.oracle`. Pays identity rent. */
  ORACLE_KEYPAIR: z.string().default('~/.config/solana/id.json'),
  /** Registry address the oracle attests into. */
  REGISTRY: z.string(),
  API_KEY: z.string().min(32, 'API_KEY must be at least 32 characters'),
  KYC_PROVIDER: z.enum(['mock']).default('mock'),
  MOCK_WEBHOOK_SECRET: z.string().min(16).optional(),
  KYC_VALIDITY_DAYS: z.coerce.number().int().positive().default(365),
  EXPIRY_WARNING_DAYS: z.coerce.number().int().positive().default(30),
});

export type Config = z.output<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid oracle config:\n${z.prettifyError(result.error)}`);
  return result.data;
}
