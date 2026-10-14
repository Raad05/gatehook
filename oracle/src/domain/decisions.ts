import { jurisdictionIndex } from '@gatehook/sdk';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { schema } from '../db/client.ts';
import { HttpError } from '../errors.ts';
import type { KycDecision } from '../providers/types.ts';
import { audit } from './audit.ts';
import { enqueueReconcile } from './jobs.ts';

const DAY_MS = 86_400_000;

export type ApplyResult = 'applied' | 'duplicate' | 'stale';

/**
 * Records a provider decision and schedules on-chain reconciliation for the
 * applicant's linked wallets. Idempotent per event id; events reviewed before
 * the stored decision are ignored (providers may deliver out of order).
 */
export async function applyDecision(
  db: Db,
  provider: string,
  decision: KycDecision,
  opts: { kycValidityDays: number; now: Date },
): Promise<ApplyResult> {
  let tier: number | null = null;
  let jurisdiction: number | null = null;
  let kycExpiry: Date | null = null;
  if (decision.status === 'approved') {
    if (decision.tier === undefined || !decision.country) {
      throw new HttpError(400, 'invalid_payload', 'Approved decisions need tier and country');
    }
    tier = decision.tier;
    try {
      jurisdiction = jurisdictionIndex(decision.country);
    } catch {
      throw new HttpError(400, 'invalid_payload', `Unknown country: ${decision.country}`);
    }
    kycExpiry = decision.expiresAt ?? new Date(decision.reviewedAt.getTime() + opts.kycValidityDays * DAY_MS);
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.webhookEvents)
      .values({ provider, eventId: decision.eventId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return 'duplicate';

    const [existing] = await tx.select().from(schema.applicants).where(eq(schema.applicants.id, decision.applicantId));
    if (existing && decision.reviewedAt <= existing.reviewedAt) {
      await audit(tx, provider, 'decision_stale', decision.applicantId, { eventId: decision.eventId });
      return 'stale';
    }

    const values = {
      provider,
      status: decision.status,
      tier,
      jurisdiction,
      kycExpiry,
      lockupUntil: decision.lockupUntil ?? null,
      reviewedAt: decision.reviewedAt,
      updatedAt: opts.now,
    };
    await tx
      .insert(schema.applicants)
      .values({ id: decision.applicantId, ...values })
      .onConflictDoUpdate({ target: schema.applicants.id, set: values });

    const linked = await tx
      .select({ address: schema.wallets.address })
      .from(schema.wallets)
      .where(eq(schema.wallets.applicantId, decision.applicantId));
    for (const { address } of linked) await enqueueReconcile(tx, address, opts.now);

    await audit(tx, provider, 'decision_applied', decision.applicantId, {
      eventId: decision.eventId,
      status: decision.status,
      tier,
      jurisdiction,
      kycExpiry,
      wallets: linked.length,
    });
    return 'applied';
  });
}
