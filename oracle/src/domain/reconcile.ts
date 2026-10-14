import type { Identity, Tier } from '@gatehook/sdk';
import type { schema } from '../db/client.ts';

type Applicant = typeof schema.applicants.$inferSelect;

export type IdentityParams = {
  tier: Tier;
  jurisdiction: number;
  /** Unix seconds. */
  kycExpiry: bigint;
  lockupUntil: bigint;
};

export type ReconcileAction =
  | { kind: 'noop' }
  | { kind: 'upsert'; params: IdentityParams }
  /** Upsert with `kycExpiry = 0`: the hook rejects the wallet, while its freeze flag and velocity counters survive. */
  | { kind: 'expire'; params: IdentityParams };

const toUnix = (d: Date | null | undefined) => (d ? BigInt(Math.floor(d.getTime() / 1000)) : 0n);

/** The on-chain identity this applicant should have, or `null` if none. */
export function desiredIdentity(applicant: Applicant | undefined, now: Date): IdentityParams | null {
  if (!applicant || applicant.status !== 'approved') return null;
  if (applicant.tier === null || applicant.jurisdiction === null || !applicant.kycExpiry) return null;
  if (applicant.kycExpiry <= now) return null;
  return {
    tier: applicant.tier as Tier,
    jurisdiction: applicant.jurisdiction,
    kycExpiry: toUnix(applicant.kycExpiry),
    lockupUntil: toUnix(applicant.lockupUntil),
  };
}

/**
 * Compares desired vs on-chain state. Identities are never closed by the
 * oracle: closing would drop an admin freeze, which a later re-approval would
 * then silently undo. Revocation expires the attestation instead.
 */
export function planReconcile(desired: IdentityParams | null, current: Identity | null, now: Date): ReconcileAction {
  if (desired) {
    const same =
      current &&
      current.tier === desired.tier &&
      current.jurisdiction === desired.jurisdiction &&
      current.kycExpiry === desired.kycExpiry &&
      current.lockupUntil === desired.lockupUntil;
    return same ? { kind: 'noop' } : { kind: 'upsert', params: desired };
  }
  if (!current || current.kycExpiry <= toUnix(now)) return { kind: 'noop' };
  return {
    kind: 'expire',
    params: { tier: current.tier, jurisdiction: current.jurisdiction, kycExpiry: 0n, lockupUntil: current.lockupUntil },
  };
}
