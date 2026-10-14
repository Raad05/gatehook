import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { address, createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';
import { buildPortal } from './app.ts';
import { loadConfig } from './config.ts';
import { runFaucet } from './faucet.ts';
import { OracleClient } from './oracle-client.ts';

const config = loadConfig();
const rpc = createSolanaRpc(config.rpcUrl);

let faucet: ((wallet: string) => Promise<unknown>) | undefined;
if (config.DEMO_FAUCET_KEYPAIR) {
  const bytes = JSON.parse(readFileSync(config.DEMO_FAUCET_KEYPAIR.replace(/^~/, homedir()), 'utf8')) as number[];
  const issuer = await createKeyPairSignerFromBytes(new Uint8Array(bytes));
  faucet = (wallet) => runFaucet(rpc, issuer, address(config.PORTAL_MINT), address(wallet));
}

const app = buildPortal({
  config,
  oracle: new OracleClient(config.ORACLE_URL, config.ORACLE_API_KEY),
  faucet,
  staticDir: process.env.NODE_ENV === 'production' ? fileURLToPath(new URL('../dist/client', import.meta.url)) : undefined,
  logger: true,
});
await app.listen({ port: config.PORT, host: config.HOST });
