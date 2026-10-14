import {
  findIdentityPda,
  getIdentityDecoder,
  type Identity,
  jurisdictionIndex,
  Tier,
} from '@gatehook/sdk';
import { Fixture, NOW } from '@gatehook/sdk/testing/fixture';
import {
  type Address,
  getBase58Decoder,
  getUtf8Encoder,
  type KeyPairSigner,
  signBytes,
} from '@solana/kit';
import { buildApp } from '../src/app.ts';
import { type Chain, upsertIdentityInstruction } from '../src/chain.ts';
import { openDb } from '../src/db/client.ts';
import type { IdentityParams } from '../src/domain/reconcile.ts';
import { MockKycProvider, type MockPayload } from '../src/providers/mock.ts';
import { processNextJob } from '../src/worker.ts';

export const API_KEY = 'test-api-key-0123456789abcdef0123456789';
export const SECRET = 'test-webhook-secret-0123456789';
export const auth = { authorization: `Bearer ${API_KEY}` };

/** Chain backed by the fixture's LiteSVM; can be told to fail N sends. */
export class LitesvmChain implements Chain {
  failNext = 0;
  sends = 0;

  constructor(private readonly f: Fixture) {}

  get registry() {
    return this.f.registry;
  }

  async getIdentity(wallet: Address): Promise<Identity | null> {
    const [pda] = await findIdentityPda({ registry: this.f.registry, wallet });
    const account = this.f.env.svm.getAccount(pda);
    return account.exists ? getIdentityDecoder().decode(account.data) : null;
  }

  async upsertIdentity(wallet: Address, params: IdentityParams): Promise<string> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated RPC failure');
    }
    this.sends++;
    await this.f.env.sendOk(this.f.oracle, [await upsertIdentityInstruction(this.f.oracle, this.f.registry, wallet, params)]);
    return `litesvm-${this.sends}`;
  }
}

/** Oracle app on PGlite + LiteSVM, sharing a controllable clock with the SVM. */
export async function createOracle() {
  const f = await Fixture.create();
  const { db, close } = await openDb('pglite://memory');
  const chain = new LitesvmChain(f);
  const provider = new MockKycProvider(SECRET);
  const clock = { now: new Date(Number(NOW) * 1000) };
  const now = () => clock.now;
  const app = buildApp({ db, provider, apiKey: API_KEY, kycValidityDays: 365, now });
  let eventSeq = 0;

  const setTime = (date: Date) => {
    clock.now = date;
    f.env.setTime(BigInt(Math.floor(date.getTime() / 1000)));
  };

  async function webhook(payload: Partial<MockPayload> & Pick<MockPayload, 'applicantId' | 'status'>, opts: { headers?: Record<string, string> } = {}) {
    const body = JSON.stringify({
      eventId: `evt-${++eventSeq}`,
      reviewedAt: new Date(clock.now.getTime() + eventSeq).toISOString(),
      ...payload,
    });
    return app.inject({
      method: 'POST',
      url: '/webhooks/kyc',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? provider.sign(body, clock.now.getTime())) },
      payload: body,
    });
  }

  const approve = (applicantId: string, extra: Partial<MockPayload> = {}) =>
    webhook({ applicantId, status: 'approved', tier: 'accredited', country: 'DE', ...extra });

  async function link(applicantId: string, wallet: KeyPairSigner) {
    const challenge = await app.inject({
      method: 'POST',
      url: `/wallets/${wallet.address}/challenge`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { applicantId },
    });
    if (challenge.statusCode !== 200) return challenge;
    const { nonce, message } = challenge.json<{ nonce: string; message: string }>();
    const signature = getBase58Decoder().decode(await signBytes(wallet.keyPair.privateKey, getUtf8Encoder().encode(message)));
    return app.inject({
      method: 'POST',
      url: `/wallets/${wallet.address}/link`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { nonce, signature },
    });
  }

  /** Runs the worker until the queue has no due jobs. */
  async function drain() {
    let processed = 0;
    while (await processNextJob({ db, chain, now })) processed++;
    return processed;
  }

  return { f, db, close, app, chain, provider, clock, setTime, webhook, approve, link, drain };
}

export const DE = jurisdictionIndex('DE');
export { Tier };
