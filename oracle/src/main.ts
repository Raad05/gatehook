import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { address, createKeyPairSignerFromBytes } from '@solana/kit';
import { buildApp } from './app.ts';
import { RpcChain } from './chain.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/client.ts';
import { sweepExpiringKyc } from './domain/sweeper.ts';
import { MockKycProvider } from './providers/mock.ts';
import type { KycProvider } from './providers/types.ts';
import { runWorker } from './worker.ts';

const config = loadConfig();

function provider(): KycProvider {
  switch (config.KYC_PROVIDER) {
    case 'mock':
      if (!config.MOCK_WEBHOOK_SECRET) throw new Error('MOCK_WEBHOOK_SECRET is required for the mock provider');
      return new MockKycProvider(config.MOCK_WEBHOOK_SECRET);
  }
}

const secret = JSON.parse(readFileSync(config.ORACLE_KEYPAIR.replace(/^~/, homedir()), 'utf8')) as number[];
const oracle = await createKeyPairSignerFromBytes(new Uint8Array(secret));
const chain = new RpcChain(oracle, address(config.REGISTRY), { http: config.RPC_URL, ws: config.WS_URL });
const { db, close } = await openDb(config.DATABASE_URL);

const app = buildApp({ db, provider: provider(), apiKey: config.API_KEY, kycValidityDays: config.KYC_VALIDITY_DAYS, logger: true });
const shutdown = new AbortController();
const now = () => new Date();

const worker = runWorker({ db, chain, now, log: app.log }, shutdown.signal);
const sweep = () =>
  sweepExpiringKyc(db, now(), config.EXPIRY_WARNING_DAYS)
    .then((expiring) => expiring.length && app.log.info({ count: expiring.length }, 'KYC expiring soon'))
    .catch((err: unknown) => app.log.error({ err }, 'sweep failed'));
void sweep();
const sweeper = setInterval(sweep, 6 * 3_600_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    shutdown.abort();
    clearInterval(sweeper);
    await app.close();
    await worker;
    await close();
    process.exit(0);
  });
}

app.log.info({ oracle: oracle.address, registry: config.REGISTRY }, 'oracle starting');
await app.listen({ port: config.PORT, host: config.HOST });
