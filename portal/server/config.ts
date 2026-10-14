import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().default(8788),
  HOST: z.string().default('127.0.0.1'),
  /** Oracle base URL and API key. The key never reaches the browser. */
  ORACLE_URL: z.string().url().default('http://127.0.0.1:8787'),
  ORACLE_API_KEY: z.string().min(32),
  /** Token the portal is for. */
  PORTAL_MINT: z.string(),
  CLUSTER: z.enum(['localnet', 'devnet']).default('devnet'),
  RPC_URL: z.string().url().optional(),
  /**
   * DEMO ONLY. When set, "Complete KYC" sends a signed mock-provider webhook to
   * the oracle. A real portal embeds the KYC provider's widget instead and the
   * provider calls the oracle directly.
   */
  DEMO_MOCK_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** DEMO ONLY. Issuer keypair path; enables the devnet faucet (SOL + tokens from the treasury). */
  DEMO_FAUCET_KEYPAIR: z.string().optional(),
});

export type PortalConfig = z.output<typeof schema> & { rpcUrl: string };

const DEFAULT_RPC = { localnet: 'http://127.0.0.1:8899', devnet: 'https://api.devnet.solana.com' } as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid portal config:\n${z.prettifyError(result.error)}`);
  return { ...result.data, rpcUrl: result.data.RPC_URL ?? DEFAULT_RPC[result.data.CLUSTER] };
}
