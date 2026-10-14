// Shared cluster/env helpers for the issuer scripts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  airdropFactory,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';

const CLUSTERS = {
  localnet: { http: 'http://127.0.0.1:8899', ws: 'ws://127.0.0.1:8900' },
  devnet: { http: 'https://api.devnet.solana.com', ws: 'wss://api.devnet.solana.com' },
} as const;

export type ClusterName = keyof typeof CLUSTERS;

export const cluster = (process.env.CLUSTER ?? 'localnet') as ClusterName;
if (!(cluster in CLUSTERS)) throw new Error(`CLUSTER must be one of: ${Object.keys(CLUSTERS).join(', ')}`);

const urls = {
  http: process.env.RPC_URL ?? CLUSTERS[cluster].http,
  ws: process.env.WS_URL ?? CLUSTERS[cluster].ws,
};
export const rpc = createSolanaRpc(urls.http);
export const rpcSubscriptions = createSolanaRpcSubscriptions(urls.ws);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

export async function loadKeypair(path: string): Promise<KeyPairSigner> {
  const bytes = JSON.parse(readFileSync(path.replace(/^~/, homedir()), 'utf8')) as number[];
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

// Memoized: kit rejects two distinct signer objects for one address in a tx.
let issuer: Promise<KeyPairSigner> | undefined;

/** Issuer = registry admin, mint authority, hook authority. */
export function loadIssuer(): Promise<KeyPairSigner> {
  issuer ??= loadKeypair(process.env.ISSUER_KEYPAIR ?? '~/.config/solana/id.json');
  return issuer;
}

/** Oracle key; defaults to the issuer for local demos. */
export async function loadOracle(): Promise<KeyPairSigner> {
  return process.env.ORACLE_KEYPAIR ? loadKeypair(process.env.ORACLE_KEYPAIR) : loadIssuer();
}

export async function send(payer: KeyPairSigner, instructions: Instruction[]): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(tx);
  await sendAndConfirm(tx, { commitment: 'confirmed' });
  return getSignatureFromTransaction(tx);
}

/** Airdrop on localnet; transfer from `funder` elsewhere (devnet faucet is rate-limited). */
export async function fund(funder: KeyPairSigner, recipient: Address, sol: number) {
  const amount = lamports(BigInt(Math.round(sol * 1e9)));
  if (cluster === 'localnet') {
    await airdropFactory({ rpc, rpcSubscriptions })({ recipientAddress: recipient, lamports: amount, commitment: 'confirmed' });
  } else {
    await send(funder, [getTransferSolInstruction({ source: funder, destination: recipient, amount })]);
  }
}

export function explorer(signature: string): string {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : `?cluster=custom&customUrl=${encodeURIComponent(urls.http)}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

// ---- persisted demo state (scripts/.state/<cluster>.json) ----

export type DemoHolder = { name: string; secretKey: number[]; address: Address };
export type DemoState = { mint?: Address; registry?: Address; decimals?: number; holders?: DemoHolder[] };

const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', `${cluster}.json`);

export function readState(): DemoState {
  return existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as DemoState) : {};
}

export function writeState(state: DemoState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`state -> ${resolve(STATE_PATH)}`);
}

export function requireState<K extends keyof DemoState>(state: DemoState, ...keys: K[]): Required<Pick<DemoState, K>> {
  for (const key of keys) {
    if (state[key] === undefined) throw new Error(`Missing "${key}" in demo state; run the earlier script first.`);
  }
  return state as Required<Pick<DemoState, K>>;
}

/** Throwaway keypair persisted in demo state (demo/devnet only). */
export async function newDemoHolder(name: string): Promise<{ holder: DemoHolder; signer: KeyPairSigner }> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const secretKey = [...pkcs8.slice(-32), ...raw];
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(secretKey));
  return { holder: { name, secretKey, address: signer.address }, signer };
}

export const holderSigner = (holder: DemoHolder) => createKeyPairSignerFromBytes(new Uint8Array(holder.secretKey));

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export { generateKeyPairSigner, getBase58Decoder };
