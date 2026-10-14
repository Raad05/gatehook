import { and, eq, gt, lt, lte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { schema } from '../db/client.ts';
import { audit } from './audit.ts';

/**
 * Flags approved applicants whose KYC expires within `withinDays` so the
 * issuer can prompt re-verification. Enforcement needs no action: the hook
 * rejects expired attestations on its own.
 */
export async function sweepExpiringKyc(db: Db, now: Date, withinDays: number) {
  const horizon = new Date(now.getTime() + withinDays * 86_400_000);
  const expiring = await db
    .select({ id: schema.applicants.id, kycExpiry: schema.applicants.kycExpiry })
    .from(schema.applicants)
    .where(
      and(
        eq(schema.applicants.status, 'approved'),
        gt(schema.applicants.kycExpiry, now),
        lte(schema.applicants.kycExpiry, horizon),
      ),
    );
  if (expiring.length > 0) await audit(db, 'sweeper', 'kyc_expiring', null, { applicants: expiring });
  return expiring;
}

/** Deletes link challenges that expired more than a day ago. */
export async function pruneLinkChallenges(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(schema.linkChallenges)
    .where(lt(schema.linkChallenges.expiresAt, new Date(now.getTime() - 86_400_000)))
    .returning({ nonce: schema.linkChallenges.nonce });
  return rows.length;
}
