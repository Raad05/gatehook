import { type Identity, Tier } from '@gatehook/sdk';
import { describe, expect, it } from 'vitest';
import { backoffMs } from '../src/domain/jobs.ts';
import { desiredIdentity, planReconcile } from '../src/domain/reconcile.ts';
import { MockKycProvider } from '../src/providers/mock.ts';

const NOW = new Date('2026-01-01T00:00:00Z');
const NOW_S = BigInt(NOW.getTime() / 1000);

type Applicant = Parameters<typeof desiredIdentity>[0] & object;
const applicant = (over: Partial<Applicant> = {}): Applicant => ({
  id: 'a1',
  provider: 'mock',
  status: 'approved',
  tier: Tier.RegDAccredited,
  jurisdiction: 1,
  kycExpiry: new Date('2027-01-01T00:00:00Z'),
  lockupUntil: null,
  reviewedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const identity = (over: Partial<Identity> = {}): Identity => ({
  discriminator: new Uint8Array(8),
  version: 1,
  registry: '11111111111111111111111111111111' as Identity['registry'],
  wallet: '11111111111111111111111111111111' as Identity['wallet'],
  tier: Tier.RegDAccredited,
  jurisdiction: 1,
  kycExpiry: BigInt(Date.parse('2027-01-01T00:00:00Z') / 1000),
  lockupUntil: 0n,
  frozen: false,
  windowStart: 0n,
  windowVolume: 0n,
  bump: 255,
  reserved: new Uint8Array(64),
  ...over,
});

describe('reconcile planning', () => {
  it('only approved, unexpired, complete applicants get an identity', () => {
    expect(desiredIdentity(applicant(), NOW)).toMatchObject({ tier: Tier.RegDAccredited, jurisdiction: 1 });
    expect(desiredIdentity(undefined, NOW)).toBeNull();
    for (const status of ['pending', 'rejected', 'revoked'] as const) {
      expect(desiredIdentity(applicant({ status }), NOW)).toBeNull();
    }
    expect(desiredIdentity(applicant({ kycExpiry: NOW }), NOW)).toBeNull();
    expect(desiredIdentity(applicant({ tier: null }), NOW)).toBeNull();
  });

  it('upserts when missing or different, noop when equal', () => {
    const desired = desiredIdentity(applicant(), NOW)!;
    expect(planReconcile(desired, null, NOW)).toEqual({ kind: 'upsert', params: desired });
    expect(planReconcile(desired, identity({ jurisdiction: 58 }), NOW)).toEqual({ kind: 'upsert', params: desired });
    expect(planReconcile(desired, identity(), NOW)).toEqual({ kind: 'noop' });
    // Freeze and velocity state are not the oracle's concern.
    expect(planReconcile(desired, identity({ frozen: true, windowVolume: 9n }), NOW)).toEqual({ kind: 'noop' });
  });

  it('expires instead of closing, keeping tier and jurisdiction', () => {
    expect(planReconcile(null, identity({ tier: Tier.RegSNonUs, jurisdiction: 58, lockupUntil: 5n }), NOW)).toEqual({
      kind: 'expire',
      params: { tier: Tier.RegSNonUs, jurisdiction: 58, kycExpiry: 0n, lockupUntil: 5n },
    });
    expect(planReconcile(null, identity({ kycExpiry: NOW_S }), NOW)).toEqual({ kind: 'noop' });
    expect(planReconcile(null, null, NOW)).toEqual({ kind: 'noop' });
  });
});

describe('mock provider', () => {
  const provider = new MockKycProvider('test-secret-0123456789');
  const body = JSON.stringify({
    eventId: 'e1',
    applicantId: 'a1',
    status: 'approved',
    tier: 'non_us',
    country: 'de',
    reviewedAt: NOW.toISOString(),
  });

  it('accepts a fresh, correctly signed webhook', () => {
    expect(() => provider.verify(provider.sign(body, NOW.getTime()), body, NOW)).not.toThrow();
    expect(provider.parse(body)).toMatchObject({ applicantId: 'a1', status: 'approved', tier: Tier.RegSNonUs, country: 'de' });
  });

  it('rejects tampered, foreign-key, stale and unsigned webhooks', () => {
    const headers = provider.sign(body, NOW.getTime());
    expect(() => provider.verify(headers, body.replace('a1', 'a2'), NOW)).toThrow(/Invalid webhook signature/);
    expect(() => provider.verify(new MockKycProvider('other-secret-0123456789').sign(body, NOW.getTime()), body, NOW)).toThrow();
    expect(() => provider.verify(headers, body, new Date(NOW.getTime() + 6 * 60_000))).toThrow(/tolerance/);
    expect(() => provider.verify({}, body, NOW)).toThrow(/Missing/);
  });

  it('rejects malformed payloads', () => {
    expect(() => provider.parse('not json')).toThrow(/JSON/);
    expect(() => provider.parse(JSON.stringify({ eventId: 'e1' }))).toThrow();
  });
});

it('backoff doubles and caps at 10 minutes', () => {
  expect([1, 2, 3].map(backoffMs)).toEqual([5_000, 10_000, 20_000]);
  expect(backoffMs(30)).toBe(600_000);
});
