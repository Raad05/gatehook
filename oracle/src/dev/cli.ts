// Dev helper for a running oracle (uses .env for URL, secret and API key).
//
//   pnpm dev:cli webhook <applicantId> <pending|approved|rejected|revoked> [--tier accredited|non_us|qualified_purchaser] [--country DE]
//   pnpm dev:cli link <applicantId> <wallet-keypair.json>
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createKeyPairSignerFromBytes, getBase58Decoder, getUtf8Encoder, signBytes } from '@solana/kit';
import { MockKycProvider } from '../providers/mock.ts';

const base = `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 8787}`;
const apiKey = process.env.API_KEY ?? '';
const [command, applicantId, third] = process.argv.slice(2);
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function call(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

if (command === 'webhook' && applicantId && third) {
  const provider = new MockKycProvider(process.env.MOCK_WEBHOOK_SECRET ?? '');
  const body = JSON.stringify({
    eventId: randomUUID(),
    applicantId,
    status: third,
    tier: flag('tier') ?? (third === 'approved' ? 'accredited' : undefined),
    country: flag('country') ?? (third === 'approved' ? 'US' : undefined),
    reviewedAt: new Date().toISOString(),
  });
  console.log(await call('/webhooks/kyc', body, provider.sign(body, Date.now())));
} else if (command === 'link' && applicantId && third) {
  const secret = JSON.parse(readFileSync(third.replace(/^~/, homedir()), 'utf8')) as number[];
  const wallet = await createKeyPairSignerFromBytes(new Uint8Array(secret));
  const { nonce, message } = (await call(`/wallets/${wallet.address}/challenge`, { applicantId })) as { nonce: string; message: string };
  const signature = getBase58Decoder().decode(await signBytes(wallet.keyPair.privateKey, getUtf8Encoder().encode(message)));
  console.log(await call(`/wallets/${wallet.address}/link`, { nonce, signature }));
} else {
  console.error('usage: webhook <applicantId> <status> [--tier t] [--country CC] | link <applicantId> <keypair.json>');
  process.exit(1);
}
