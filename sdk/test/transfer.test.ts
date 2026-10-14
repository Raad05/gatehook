import { getTransferCheckedWithTransferHookInstructionAsync } from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';
import {
  fetchComplianceConfig,
  fetchMaybeIdentity,
  fetchRegistry,
  findConfigPda,
  findIdentityPda,
  GATEHOOK_ERROR__HOLDER_LOCKUP,
  GATEHOOK_ERROR__PAUSED,
  GATEHOOK_ERROR__RECIPIENT_IDENTITY_NOT_FOUND,
  GATEHOOK_ERROR__REG_S_RESTRICTED,
  GATEHOOK_ERROR__SENDER_KYC_EXPIRED,
  GATEHOOK_ERROR__VELOCITY_LIMIT_EXCEEDED,
  getCompliantTransferInstruction,
  getSetPauseInstruction,
  preflightTransfer,
  type PreflightResult,
  Tier,
} from '../src/index.ts';
import { DEFAULT_RULES, Fixture, type Holder, NOW } from './fixture.ts';
import { DECIMALS } from './litesvm.ts';

async function compliantTransfer(f: Fixture, from: Holder, to: Holder, amount: bigint) {
  return getCompliantTransferInstruction({
    source: from.token,
    destination: to.token,
    mint: f.mint,
    authority: from.wallet,
    destinationOwner: to.wallet.address,
    registry: f.registry,
    amount,
    decimals: DECIMALS,
  });
}

async function preflight(f: Fixture, from: Holder, to: Holder, amount: bigint): Promise<PreflightResult> {
  const rpc = f.env.rpc();
  const [configAddress] = await findConfigPda({ mint: f.mint });
  const [[senderAddress], [recipientAddress]] = await Promise.all([
    findIdentityPda({ registry: f.registry, wallet: from.wallet.address }),
    findIdentityPda({ registry: f.registry, wallet: to.wallet.address }),
  ]);
  const [config, registry, sender, recipient] = await Promise.all([
    fetchComplianceConfig(rpc, configAddress),
    fetchRegistry(rpc, f.registry),
    fetchMaybeIdentity(rpc, senderAddress),
    fetchMaybeIdentity(rpc, recipientAddress),
  ]);
  return preflightTransfer({
    config: config.data,
    registry: registry.data,
    sender: sender.exists ? sender.data : null,
    recipient: recipient.exists ? recipient.data : null,
    sourceOwner: from.wallet.address,
    destinationOwner: to.wallet.address,
    authority: from.wallet.address,
    amount,
    now: f.env.svm.getClock().unixTimestamp,
  });
}

/** Asserts preflight predicts exactly what the chain does. */
async function expectParity(f: Fixture, from: Holder, to: Holder, amount: bigint, expectedCode: number | null) {
  const predicted = await preflight(f, from, to, amount);
  const result = await f.env.send(from.wallet, [await compliantTransfer(f, from, to, amount)]);
  if (expectedCode === null) {
    expect(predicted).toEqual({ ok: true, forced: false });
    expect(result.ok, !result.ok ? result.logs.join('\n') : '').toBe(true);
  } else {
    expect(predicted).toMatchObject({ ok: false, code: expectedCode });
    expect(result).toMatchObject({ ok: false, code: expectedCode });
  }
}

describe('compliant transfers', () => {
  it('offline builder matches the generic Token-2022 hook resolver', async () => {
    const f = await Fixture.create();
    const a = await f.holder(1_000n);
    const b = await f.holder();

    const offline = await compliantTransfer(f, a, b, 10n);
    const resolved = await getTransferCheckedWithTransferHookInstructionAsync(
      { rpc: f.env.rpc() },
      { source: a.token, mint: f.mint, destination: b.token, authority: a.wallet, amount: 10n, decimals: DECIMALS },
    );
    expect(resolved.accounts?.map((m) => [m.address, m.role])).toEqual(offline.accounts?.map((m) => [m.address, m.role]));

    // DEX-style path: transfer built purely by the generic resolver.
    await f.env.sendOk(a.wallet, [resolved]);
  });

  it('succeeds and stays within the CU budget', async () => {
    const f = await Fixture.create({ ...DEFAULT_RULES, velocityWindowSecs: 3_600n, velocityLimits: { [Tier.RegDAccredited]: 1_000n } });
    const a = await f.holder(1_000n);
    const b = await f.holder();
    const cu = await f.env.sendOk(a.wallet, [await compliantTransfer(f, a, b, 10n)]);
    expect(cu).toBeLessThan(60_000n);
  });
});

describe('preflight parity with the on-chain hook', () => {
  it('missing recipient identity', async () => {
    const f = await Fixture.create();
    const a = await f.holder(1_000n);
    const b = await f.holder(0n, null);
    await expectParity(f, a, b, 1n, GATEHOOK_ERROR__RECIPIENT_IDENTITY_NOT_FOUND);
  });

  it('paused mint', async () => {
    const f = await Fixture.create();
    const a = await f.holder(1_000n);
    const b = await f.holder();
    const [config] = await findConfigPda({ mint: f.mint });
    await f.env.sendOk(f.issuer, [getSetPauseInstruction({ admin: f.issuer, registry: f.registry, config, paused: true })]);
    await expectParity(f, a, b, 1n, GATEHOOK_ERROR__PAUSED);
  });

  it('expired KYC', async () => {
    const f = await Fixture.create();
    const a = await f.holder(1_000n, { kycExpiry: NOW });
    const b = await f.holder();
    await expectParity(f, a, b, 1n, GATEHOOK_ERROR__SENDER_KYC_EXPIRED);
  });

  it('Reg S to US during compliance period', async () => {
    const f = await Fixture.create({ ...DEFAULT_RULES, regSComplianceUntil: NOW + 100n });
    const a = await f.holder(1_000n, { tier: Tier.RegSNonUs, jurisdiction: 'DE' });
    const us = await f.holder();
    const de = await f.holder(0n, { jurisdiction: 'DE' });
    await expectParity(f, a, us, 1n, GATEHOOK_ERROR__REG_S_RESTRICTED);
    await expectParity(f, a, de, 1n, null);
  });

  it('holder lockup then release', async () => {
    const f = await Fixture.create();
    const a = await f.holder(1_000n, { lockupUntil: NOW + 10n });
    const b = await f.holder();
    await expectParity(f, a, b, 1n, GATEHOOK_ERROR__HOLDER_LOCKUP);
    f.env.setTime(NOW + 10n);
    await expectParity(f, a, b, 1n, null);
  });

  it('velocity limit across a window', async () => {
    const f = await Fixture.create({ ...DEFAULT_RULES, velocityWindowSecs: 3_600n, velocityLimits: { [Tier.RegDAccredited]: 100n } });
    const a = await f.holder(1_000n);
    const b = await f.holder();
    await expectParity(f, a, b, 60n, null);
    await expectParity(f, a, b, 41n, GATEHOOK_ERROR__VELOCITY_LIMIT_EXCEEDED);
    await expectParity(f, a, b, 40n, null);
    f.env.setTime(NOW + 3_600n);
    await expectParity(f, a, b, 100n, null);
  });
});
