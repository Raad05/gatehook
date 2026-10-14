import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Latest KYC decision per provider applicant. */
export const applicants = pgTable('applicants', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'rejected', 'revoked'] }).notNull(),
  /** On-chain `Tier` value; null until approved. */
  tier: smallint('tier'),
  /** On-chain jurisdiction index (see sdk/src/jurisdictions.ts). */
  jurisdiction: smallint('jurisdiction'),
  kycExpiry: ts('kyc_expiry'),
  lockupUntil: ts('lockup_until'),
  /** Provider review time of the applied event; older events are ignored. */
  reviewedAt: ts('reviewed_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Wallets proven (by signature) to belong to an applicant. */
export const wallets = pgTable(
  'wallets',
  {
    address: text('address').primaryKey(),
    applicantId: text('applicant_id')
      .notNull()
      .references(() => applicants.id),
    linkedAt: ts('linked_at').notNull().defaultNow(),
  },
  (t) => [index('wallets_applicant_idx').on(t.applicantId)],
);

export const linkChallenges = pgTable('link_challenges', {
  nonce: text('nonce').primaryKey(),
  applicantId: text('applicant_id').notNull(),
  wallet: text('wallet').notNull(),
  message: text('message').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

/** Provider event ids already processed (replay protection). */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

/** `superseded`: a retry was dropped because a newer pending job exists for the wallet. */
export const JOB_STATUSES = ['pending', 'processing', 'confirmed', 'failed', 'superseded'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * "Reconcile this wallet's on-chain identity with its applicant" jobs. The
 * desired state is computed when the job runs, so at most one pending job
 * per wallet is needed.
 */
export const onchainJobs = pgTable(
  'onchain_jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet').notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: ts('run_after').notNull().defaultNow(),
    /** 'upsert' | 'expire' | 'noop' once processed. */
    action: text('action'),
    signature: text('signature'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('onchain_jobs_one_pending_per_wallet').on(t.wallet).where(sql`${t.status} = 'pending'`),
    index('onchain_jobs_due_idx').on(t.status, t.runAfter),
  ],
);

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: ts('at').notNull().defaultNow(),
  actor: text('actor').notNull(),
  event: text('event').notNull(),
  subject: text('subject'),
  data: jsonb('data'),
});
