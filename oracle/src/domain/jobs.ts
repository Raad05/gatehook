import { and, eq, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { schema } from '../db/client.ts';

const { onchainJobs } = schema;
export type Job = typeof onchainJobs.$inferSelect;

export const MAX_ATTEMPTS = 8;
/** A `processing` job untouched for this long is assumed orphaned (crash) and reclaimed. */
const LEASE_MS = 5 * 60_000;

/** Schedules a reconcile for `wallet`; no-op if one is already pending. */
export async function enqueueReconcile(db: Db, wallet: string, now: Date) {
  await db.insert(onchainJobs).values({ wallet, runAfter: now, createdAt: now, updatedAt: now }).onConflictDoNothing();
}

/** Atomically claims the next due job (SKIP LOCKED, safe with several workers). */
export async function claimNextJob(db: Db, now: Date): Promise<Job | undefined> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(onchainJobs)
      .where(
        or(
          and(eq(onchainJobs.status, 'pending'), lte(onchainJobs.runAfter, now)),
          and(eq(onchainJobs.status, 'processing'), lt(onchainJobs.updatedAt, new Date(now.getTime() - LEASE_MS))),
        ),
      )
      .orderBy(onchainJobs.runAfter, onchainJobs.id)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!job) return undefined;
    const [claimed] = await tx
      .update(onchainJobs)
      .set({ status: 'processing', attempts: sql`${onchainJobs.attempts} + 1`, updatedAt: now })
      .where(eq(onchainJobs.id, job.id))
      .returning();
    return claimed;
  });
}

export async function completeJob(db: Db, job: Job, action: string, signature: string | null, now: Date) {
  await db
    .update(onchainJobs)
    .set({ status: 'confirmed', action, signature, lastError: null, updatedAt: now })
    .where(eq(onchainJobs.id, job.id));
}

/** Exponential backoff: 5s, 10s, 20s ... capped at 10 min. */
export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** (attempts - 1), 10 * 60_000);
}

/** Reschedules with backoff, or marks `failed` after `MAX_ATTEMPTS`. */
export async function failJob(db: Db, job: Job, error: string, now: Date): Promise<Job['status']> {
  return db.transaction(async (tx) => {
    if (job.attempts >= MAX_ATTEMPTS) {
      await tx.update(onchainJobs).set({ status: 'failed', lastError: error, updatedAt: now }).where(eq(onchainJobs.id, job.id));
      return 'failed';
    }
    // A newer pending job already covers this wallet (desired state is computed at run time).
    const [newer] = await tx
      .select({ id: onchainJobs.id })
      .from(onchainJobs)
      .where(and(eq(onchainJobs.wallet, job.wallet), eq(onchainJobs.status, 'pending')))
      .limit(1);
    const status = newer ? 'superseded' : 'pending';
    await tx
      .update(onchainJobs)
      .set({ status, lastError: error, runAfter: new Date(now.getTime() + backoffMs(job.attempts)), updatedAt: now })
      .where(eq(onchainJobs.id, job.id));
    return status;
  });
}

/**
 * Manually re-queues a failed job (admin API). Returns false if the job is
 * not `failed`; if the wallet already has a pending job, that one covers it.
 */
export async function retryJob(db: Db, id: number, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(onchainJobs).where(eq(onchainJobs.id, id)).for('update');
    if (job?.status !== 'failed') return false;
    const [pending] = await tx
      .select({ id: onchainJobs.id })
      .from(onchainJobs)
      .where(and(eq(onchainJobs.wallet, job.wallet), eq(onchainJobs.status, 'pending')));
    await tx
      .update(onchainJobs)
      .set(pending ? { status: 'superseded', updatedAt: now } : { status: 'pending', attempts: 0, runAfter: now, updatedAt: now })
      .where(eq(onchainJobs.id, id));
    return true;
  });
}
