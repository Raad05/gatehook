import { address } from '@solana/kit';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Chain } from './chain.ts';
import type { Db } from './db/client.ts';
import { schema } from './db/client.ts';
import { audit } from './domain/audit.ts';
import { claimNextJob, completeJob, failJob, type Job } from './domain/jobs.ts';
import { desiredIdentity, planReconcile } from './domain/reconcile.ts';

export type WorkerDeps = { db: Db; chain: Chain; now: () => Date; log?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'> };

async function reconcile({ db, chain, now }: WorkerDeps, job: Job) {
  const [row] = await db
    .select({ applicant: schema.applicants })
    .from(schema.wallets)
    .innerJoin(schema.applicants, eq(schema.wallets.applicantId, schema.applicants.id))
    .where(eq(schema.wallets.address, job.wallet));
  const wallet = address(job.wallet);
  const at = now();
  const action = planReconcile(desiredIdentity(row?.applicant, at), await chain.getIdentity(wallet), at);
  const signature = action.kind === 'noop' ? null : await chain.upsertIdentity(wallet, action.params);
  return { action: action.kind, signature };
}

/**
 * Processes one due job. Returns false when the queue is empty. Safe to
 * retry: the action is recomputed from current DB + chain state each run,
 * so a tx that landed but timed out becomes a noop.
 */
export async function processNextJob(deps: WorkerDeps): Promise<boolean> {
  const job = await claimNextJob(deps.db, deps.now());
  if (!job) return false;
  try {
    const { action, signature } = await reconcile(deps, job);
    await completeJob(deps.db, job, action, signature, deps.now());
    if (action !== 'noop') await audit(deps.db, 'worker', `identity_${action}`, job.wallet, { jobId: job.id, signature });
    deps.log?.info({ jobId: job.id, wallet: job.wallet, action, signature }, 'job confirmed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = await failJob(deps.db, job, message, deps.now());
    deps.log?.warn({ jobId: job.id, wallet: job.wallet, attempts: job.attempts, status, err: message }, 'job failed');
  }
  return true;
}

/** Drains due jobs, then polls every `intervalMs` until `signal` aborts. */
export async function runWorker(deps: WorkerDeps, signal: AbortSignal, intervalMs = 2_000) {
  while (!signal.aborted) {
    try {
      while (!signal.aborted && (await processNextJob(deps))) {}
    } catch (error) {
      deps.log?.error({ err: error }, 'worker loop error');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs).unref());
  }
}
