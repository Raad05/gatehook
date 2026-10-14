import {
  findConfigPda,
  findIdentityPda,
  GATEHOOK_ERROR__RECIPIENT_KYC_EXPIRED,
  getCompliantTransferInstruction,
  getSetIdentityFrozenInstruction,
} from '@gatehook/sdk';
import type { Holder } from '@gatehook/sdk/testing/fixture';
import { DECIMALS } from '@gatehook/sdk/testing';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { MAX_ATTEMPTS } from '../src/domain/jobs.ts';
import { sweepExpiringKyc } from '../src/domain/sweeper.ts';
import { auth, createOracle, DE, Tier } from './harness.ts';

type Oracle = Awaited<ReturnType<typeof createOracle>>;
let o: Oracle;
afterEach(async () => {
  await o?.close();
});

async function transfer(from: Holder, to: Holder, amount = 1n) {
  return o.f.env.send(from.wallet, [
    await getCompliantTransferInstruction({
      source: from.token,
      destination: to.token,
      mint: o.f.mint,
      authority: from.wallet,
      destinationOwner: to.wallet.address,
      registry: o.f.registry,
      amount,
      decimals: DECIMALS,
    }),
  ]);
}

describe('KYC -> wallet link -> on-chain identity', () => {
  it('approval plus wallet link produces an identity that passes the hook', async () => {
    o = await createOracle();
    const sender = await o.f.holder(1_000n); // attested directly by the fixture
    const investor = await o.f.holder(0n, null); // no identity yet

    expect(await transfer(sender, investor)).toMatchObject({ ok: false });

    expect((await o.approve('app-1', { tier: 'non_us' })).json()).toEqual({ result: 'applied' });
    expect((await o.link('app-1', investor.wallet)).statusCode).toBe(200);
    expect(await o.drain()).toBe(1);

    const identity = await o.chain.getIdentity(investor.wallet.address);
    expect(identity).toMatchObject({ tier: Tier.RegSNonUs, jurisdiction: DE, frozen: false });
    expect(identity!.kycExpiry).toBe(BigInt(Math.floor(o.clock.now.getTime() / 1000)) + 365n * 86_400n);
    expect(await transfer(sender, investor)).toMatchObject({ ok: true });

    const [job] = await o.db.select().from(schema.onchainJobs);
    expect(job).toMatchObject({ status: 'confirmed', action: 'upsert', signature: 'litesvm-1' });
  });

  it('linking before approval waits, then approval writes the identity', async () => {
    o = await createOracle();
    const investor = await o.f.holder(0n, null);
    await o.webhook({ applicantId: 'app-1', status: 'pending' });
    expect((await o.link('app-1', investor.wallet)).statusCode).toBe(200);
    await o.drain();
    expect(await o.chain.getIdentity(investor.wallet.address)).toBeNull();

    await o.approve('app-1');
    await o.drain();
    expect(await o.chain.getIdentity(investor.wallet.address)).toMatchObject({ tier: Tier.RegDAccredited });
  });

  it('revocation expires the identity and keeps an admin freeze across re-approval', async () => {
    o = await createOracle();
    const sender = await o.f.holder(1_000n);
    const investor = await o.f.holder(0n, null);
    await o.approve('app-1');
    await o.link('app-1', investor.wallet);
    await o.drain();

    await o.webhook({ applicantId: 'app-1', status: 'revoked' });
    await o.drain();
    expect((await o.chain.getIdentity(investor.wallet.address))!.kycExpiry).toBe(0n);
    expect(await transfer(sender, investor)).toMatchObject({ ok: false, code: GATEHOOK_ERROR__RECIPIENT_KYC_EXPIRED });

    // Admin freezes the wallet, then KYC is re-approved: freeze must survive.
    const [identity] = await findIdentityPda({ registry: o.f.registry, wallet: investor.wallet.address });
    await o.f.env.sendOk(o.f.issuer, [
      getSetIdentityFrozenInstruction({ authority: o.f.issuer, registry: o.f.registry, identity, frozen: true }),
    ]);
    await o.approve('app-1');
    await o.drain();
    const after = await o.chain.getIdentity(investor.wallet.address);
    expect(after!.kycExpiry).toBeGreaterThan(0n);
    expect(after!.frozen).toBe(true);
  });

  it('re-running a confirmed reconcile is a noop', async () => {
    o = await createOracle();
    const investor = await o.f.holder(0n, null);
    await o.approve('app-1');
    await o.link('app-1', investor.wallet);
    await o.drain();
    await o.db.insert(schema.onchainJobs).values({ wallet: investor.wallet.address, runAfter: o.clock.now });
    await o.drain();
    expect(o.chain.sends).toBe(1);
    const jobs = await o.db.select().from(schema.onchainJobs).where(eq(schema.onchainJobs.action, 'noop'));
    expect(jobs).toHaveLength(1);
  });

  it('several decisions before the worker runs collapse into one job', async () => {
    o = await createOracle();
    const investor = await o.f.holder(0n, null);
    await o.approve('app-1');
    await o.link('app-1', investor.wallet);
    await o.approve('app-1', { tier: 'qualified_purchaser' });
    await o.approve('app-1', { country: 'US' });
    expect(await o.drain()).toBe(1);
    expect(await o.chain.getIdentity(investor.wallet.address)).toMatchObject({ tier: Tier.RegDAccredited, jurisdiction: 1 });
  });
});

describe('webhook security', () => {
  it('rejects bad signatures and stale timestamps', async () => {
    o = await createOracle();
    const bad = await o.webhook({ applicantId: 'a', status: 'pending' }, { headers: { 'x-mock-signature': '00', 'x-mock-timestamp': String(o.clock.now.getTime()) } });
    expect(bad.statusCode).toBe(401);
    const body = JSON.stringify({ eventId: 'x', applicantId: 'a', status: 'pending', reviewedAt: o.clock.now.toISOString() });
    const stale = await o.app.inject({
      method: 'POST',
      url: '/webhooks/kyc',
      headers: { 'content-type': 'application/json', ...o.provider.sign(body, o.clock.now.getTime() - 10 * 60_000) },
      payload: body,
    });
    expect(stale.json()).toMatchObject({ error: 'stale_webhook' });
  });

  it('ignores replayed events and out-of-order older decisions', async () => {
    o = await createOracle();
    const reviewedAt = o.clock.now.toISOString();
    await o.approve('app-1', { eventId: 'e1', reviewedAt });
    expect((await o.approve('app-1', { eventId: 'e1', reviewedAt })).json()).toEqual({ result: 'duplicate' });
    const older = new Date(o.clock.now.getTime() - 60_000).toISOString();
    expect((await o.webhook({ applicantId: 'app-1', status: 'revoked', reviewedAt: older })).json()).toEqual({ result: 'stale' });
    const [applicant] = await o.db.select().from(schema.applicants);
    expect(applicant!.status).toBe('approved');
  });

  it('rejects incomplete or unknown approvals', async () => {
    o = await createOracle();
    expect((await o.webhook({ applicantId: 'a', status: 'approved', tier: 'accredited' })).statusCode).toBe(400);
    expect((await o.approve('a', { country: 'XX' })).json()).toMatchObject({ error: 'invalid_payload' });
  });
});

describe('API auth and wallet linking', () => {
  it('requires the API key except for health and webhooks', async () => {
    o = await createOracle();
    expect((await o.app.inject({ url: '/health' })).statusCode).toBe(200);
    expect((await o.app.inject({ url: '/jobs' })).statusCode).toBe(401);
    expect((await o.app.inject({ url: '/jobs', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await o.app.inject({ url: '/jobs', headers: auth })).statusCode).toBe(200);
  });

  it('rejects signatures from another wallet, reused and expired challenges', async () => {
    o = await createOracle();
    await o.approve('app-1');
    const wallet = await o.f.env.fundedSigner();
    const other = await o.f.env.fundedSigner();
    const post = (url: string, payload: object) =>
      o.app.inject({ method: 'POST', url, headers: { ...auth, 'content-type': 'application/json' }, payload });

    // Signature by `other` over `wallet`'s challenge.
    const challenge = (await post(`/wallets/${wallet.address}/challenge`, { applicantId: 'app-1' })).json<{ nonce: string; message: string }>();
    const { getBase58Decoder, getUtf8Encoder, signBytes } = await import('@solana/kit');
    const forged = getBase58Decoder().decode(await signBytes(other.keyPair.privateKey, getUtf8Encoder().encode(challenge.message)));
    expect((await post(`/wallets/${wallet.address}/link`, { nonce: challenge.nonce, signature: forged })).json()).toMatchObject({ error: 'invalid_signature' });

    expect((await o.link('app-1', wallet)).statusCode).toBe(200);
    const genuine = getBase58Decoder().decode(await signBytes(wallet.keyPair.privateKey, getUtf8Encoder().encode(challenge.message)));
    await post(`/wallets/${wallet.address}/link`, { nonce: challenge.nonce, signature: genuine }); // first use ok
    expect((await post(`/wallets/${wallet.address}/link`, { nonce: challenge.nonce, signature: genuine })).json()).toMatchObject({ error: 'challenge_used' });

    const late = (await post(`/wallets/${other.address}/challenge`, { applicantId: 'app-1' })).json<{ nonce: string; message: string }>();
    o.setTime(new Date(o.clock.now.getTime() + 11 * 60_000));
    const lateSig = getBase58Decoder().decode(await signBytes(other.keyPair.privateKey, getUtf8Encoder().encode(late.message)));
    expect((await post(`/wallets/${other.address}/link`, { nonce: late.nonce, signature: lateSig })).json()).toMatchObject({ error: 'challenge_expired' });
  });

  it('keeps a wallet bound to one applicant and validates inputs', async () => {
    o = await createOracle();
    await o.approve('app-1');
    await o.approve('app-2');
    const wallet = await o.f.env.fundedSigner();
    expect((await o.link('app-1', wallet)).statusCode).toBe(200);
    expect((await o.link('app-2', wallet)).json()).toMatchObject({ error: 'wallet_taken' });
    expect((await o.link('nobody', await o.f.env.fundedSigner())).statusCode).toBe(404);
    const invalid = await o.app.inject({
      method: 'POST',
      url: '/wallets/not-a-wallet/challenge',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { applicantId: 'app-1' },
    });
    expect(invalid.json()).toMatchObject({ error: 'invalid_wallet' });
  });
});

describe('worker retries', () => {
  it('backs off on failure, fails after max attempts, and can be retried', async () => {
    o = await createOracle();
    const investor = await o.f.holder(0n, null);
    await o.approve('app-1');
    await o.link('app-1', investor.wallet);
    o.chain.failNext = MAX_ATTEMPTS;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(await o.drain()).toBe(1);
      const [job] = await o.db.select().from(schema.onchainJobs);
      expect(job).toMatchObject({ attempts: attempt, status: attempt < MAX_ATTEMPTS ? 'pending' : 'failed' });
      expect(await o.drain()).toBe(0); // not due until backoff elapses
      o.setTime(new Date(o.clock.now.getTime() + 10 * 60_000));
    }

    const [failed] = await o.db.select().from(schema.onchainJobs);
    expect(failed!.lastError).toBe('simulated RPC failure');
    const retry = await o.app.inject({ method: 'POST', url: `/jobs/${failed!.id}/retry`, headers: auth });
    expect(retry.json()).toEqual({ retried: true });
    expect(await o.drain()).toBe(1);
    expect(await o.chain.getIdentity(investor.wallet.address)).not.toBeNull();
    expect((await o.app.inject({ method: 'POST', url: `/jobs/${failed!.id}/retry`, headers: auth })).statusCode).toBe(409);
  });
});

it('sweeper flags approvals expiring within the warning window', async () => {
  o = await createOracle();
  const soon = new Date(o.clock.now.getTime() + 10 * 86_400_000).toISOString();
  await o.approve('soon', { expiresAt: soon });
  await o.approve('later');
  const expiring = await sweepExpiringKyc(o.db, o.clock.now, 30);
  expect(expiring.map((a) => a.id)).toEqual(['soon']);
  const [config] = await findConfigPda({ mint: o.f.mint });
  expect(config).toBeTruthy();
});
