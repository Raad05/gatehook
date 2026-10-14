import { API_KEY, createOracle, SECRET, Tier } from '@gatehook/oracle/testing';
import { generateKeyPairSigner, getBase58Decoder, getUtf8Encoder, signBytes } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicantIdFor, buildPortal } from '../server/app.ts';
import type { PortalConfig } from '../server/config.ts';
import { OracleClient } from '../server/oracle-client.ts';

type Oracle = Awaited<ReturnType<typeof createOracle>>;
let oracle: Oracle | undefined;
afterEach(async () => {
  await oracle?.app.close();
  await oracle?.close();
  oracle = undefined;
});

async function setup(opts: { demoKyc?: boolean; faucet?: (wallet: string) => Promise<unknown> } = {}) {
  oracle = await createOracle();
  // Portal signs demo webhooks with wall-clock time; align the oracle (and SVM) clock.
  oracle.setTime(new Date());
  // Real HTTP between portal and oracle, as in production.
  const oracleUrl = await oracle.app.listen({ port: 0, host: '127.0.0.1' });
  const config: PortalConfig = {
    PORT: 0,
    HOST: '127.0.0.1',
    ORACLE_URL: oracleUrl,
    ORACLE_API_KEY: API_KEY,
    PORTAL_MINT: oracle.f.mint,
    CLUSTER: 'localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    DEMO_MOCK_WEBHOOK_SECRET: opts.demoKyc === false ? undefined : SECRET,
  };
  const portal = buildPortal({ config, oracle: new OracleClient(oracleUrl, API_KEY), faucet: opts.faucet });
  const o = oracle;

  async function signIn(email = 'investor@example.com') {
    const res = await portal.inject({ method: 'POST', url: '/api/session', payload: { email } });
    const { token } = res.json<{ token: string }>();
    const auth = { authorization: `Bearer ${token}` };
    const post = (url: string, payload: object = {}) => portal.inject({ method: 'POST', url, headers: auth, payload });
    const get = (url: string) => portal.inject({ url, headers: auth });
    /** What the browser does: challenge, sign with the wallet, link. */
    async function linkWallet() {
      const wallet = await generateKeyPairSigner();
      const { nonce, message } = (await post('/api/wallet/challenge', { wallet: wallet.address })).json<{ nonce: string; message: string }>();
      const signature = getBase58Decoder().decode(await signBytes(wallet.keyPair.privateKey, getUtf8Encoder().encode(message)));
      const res = await post('/api/wallet/link', { wallet: wallet.address, nonce, signature });
      return { wallet, res };
    }
    return { auth, post, get, linkWallet };
  }

  return { portal, o, signIn };
}

describe('investor portal server', () => {
  it('exposes public config but no secrets', async () => {
    const { portal, o } = await setup();
    const body = (await portal.inject({ url: '/api/config' })).json();
    expect(body).toEqual({ cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', mint: o.f.mint, demoKyc: true, demoFaucet: false });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('requires a session for investor endpoints', async () => {
    const { portal } = await setup();
    expect((await portal.inject({ url: '/api/status' })).statusCode).toBe(401);
    expect((await portal.inject({ method: 'POST', url: '/api/kyc', payload: {} })).statusCode).toBe(401);
    expect((await portal.inject({ method: 'POST', url: '/api/session', payload: { email: 'nope' } })).statusCode).toBe(400);
  });

  it('runs the full investor journey: KYC, wallet link, on-chain identity', async () => {
    const { o, signIn } = await setup();
    const { post, get, linkWallet } = await signIn('alice@example.com');

    expect((await get('/api/status')).json()).toMatchObject({ applicantId: applicantIdFor('alice@example.com'), applicant: null });
    expect((await post('/api/kyc', { tier: 'non_us', country: 'de' })).json()).toEqual({ result: 'applied' });
    expect((await get('/api/status')).json()).toMatchObject({ applicant: { status: 'approved', tier: Tier.RegSNonUs } });

    const { wallet, res } = await linkWallet();
    expect(res.statusCode).toBe(200);
    await o.drain();

    expect(await o.chain.getIdentity(wallet.address)).toMatchObject({ tier: Tier.RegSNonUs, frozen: false });
    const status = (await get('/api/status')).json<{ wallets: { address: string; job: { status: string; action: string } }[] }>();
    expect(status.wallets).toEqual([expect.objectContaining({ address: wallet.address, job: expect.objectContaining({ status: 'confirmed', action: 'upsert' }) })]);

    // Revoking from the portal expires the on-chain attestation.
    await post('/api/kyc', { status: 'revoked' });
    await o.drain();
    expect((await o.chain.getIdentity(wallet.address))!.kycExpiry).toBe(0n);
  });

  it('same email resumes the same applicant', async () => {
    const { signIn } = await setup();
    const first = await signIn('Bob@Example.com');
    await first.post('/api/kyc', {});
    const again = await signIn('bob@example.com');
    expect((await again.get('/api/status')).json()).toMatchObject({ applicant: { status: 'approved' } });
  });

  it('relays oracle errors with their status', async () => {
    const { signIn } = await setup();
    const { post } = await signIn();
    // No KYC yet: oracle has no applicant to link to.
    const res = await post('/api/wallet/challenge', { wallet: (await generateKeyPairSigner()).address });
    expect(res.json()).toMatchObject({ error: 'unknown_applicant' });
    expect(res.statusCode).toBe(404);
    expect((await post('/api/wallet/challenge', { wallet: 'nope' })).json()).toMatchObject({ error: 'invalid_wallet' });
  });

  it('disables demo KYC and faucet unless configured', async () => {
    const { signIn } = await setup({ demoKyc: false });
    const { post } = await signIn();
    expect((await post('/api/kyc')).statusCode).toBe(404);
    expect((await post('/api/demo/faucet', { wallet: (await generateKeyPairSigner()).address })).statusCode).toBe(404);
  });

  it('faucet only serves wallets linked to the signed-in investor', async () => {
    const faucet = vi.fn(async () => ({ signature: 'sig' }));
    const { signIn } = await setup({ faucet });
    const { post, linkWallet } = await signIn();
    await post('/api/kyc');
    const stranger = await generateKeyPairSigner();
    expect((await post('/api/demo/faucet', { wallet: stranger.address })).statusCode).toBe(403);

    const { wallet } = await linkWallet();
    expect((await post('/api/demo/faucet', { wallet: wallet.address })).json()).toEqual({ signature: 'sig' });
    expect(faucet).toHaveBeenCalledWith(wallet.address);
  });
});
