import { timingSafeEqual } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db/client.ts';
import { schema } from './db/client.ts';
import { applyDecision } from './domain/decisions.ts';
import { JOB_STATUSES } from './db/schema.ts';
import { retryJob } from './domain/jobs.ts';
import { completeLink, createChallenge } from './domain/link.ts';
import { HttpError } from './errors.ts';
import type { KycProvider } from './providers/types.ts';

export type AppDeps = {
  db: Db;
  provider: KycProvider;
  /** Bearer token for everything except the provider webhook. */
  apiKey: string;
  kycValidityDays: number;
  now?: () => Date;
  logger?: boolean;
};

function parseBody<T extends z.ZodType>(req: FastifyRequest, schema: T): z.output<T> {
  let json: unknown;
  try {
    json = typeof req.body === 'string' && req.body.length > 0 ? JSON.parse(req.body) : {};
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body is not JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new HttpError(400, 'invalid_request', z.prettifyError(result.error));
  return result.data;
}

function bearerMatches(header: string | undefined, apiKey: string): boolean {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

const walletParams = z.object({ wallet: z.string() });

export function buildApp(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ?? false });

  // Keep raw bodies: webhook signatures are computed over exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: 'bad_request', message: (error as Error).message });
    req.log.error(error);
    return reply.status(500).send({ error: 'internal', message: 'Internal error' });
  });

  app.addHook('onRequest', async (req) => {
    if (req.url === '/health' || req.url.startsWith('/webhooks/')) return;
    if (!bearerMatches(req.headers.authorization, deps.apiKey)) throw new HttpError(401, 'unauthorized', 'Missing or invalid API key');
  });

  app.get('/health', async () => ({ ok: true }));

  /** KYC provider callback; authenticated by the provider's signature. */
  app.post('/webhooks/kyc', async (req) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    deps.provider.verify(req.headers, raw, now());
    const decision = deps.provider.parse(raw);
    const result = await applyDecision(deps.db, deps.provider.name, decision, { kycValidityDays: deps.kycValidityDays, now: now() });
    return { result };
  });

  /**
   * Wallet linking, called by the issuer's investor portal (which has
   * authenticated the investor) with a signature from the investor's wallet.
   */
  app.post('/wallets/:wallet/challenge', async (req) => {
    const { wallet } = walletParams.parse(req.params);
    const { applicantId } = parseBody(req, z.object({ applicantId: z.string().min(1) }));
    return createChallenge(deps.db, { applicantId, wallet, now: now() });
  });

  app.post('/wallets/:wallet/link', async (req) => {
    const { wallet } = walletParams.parse(req.params);
    const body = parseBody(req, z.object({ nonce: z.string().min(1), signature: z.string().min(1) }));
    return completeLink(deps.db, { wallet, ...body, now: now() });
  });

  app.get('/applicants/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const [applicant] = await deps.db.select().from(schema.applicants).where(eq(schema.applicants.id, id));
    if (!applicant) throw new HttpError(404, 'unknown_applicant', 'Applicant not found');
    const wallets = await deps.db.select().from(schema.wallets).where(eq(schema.wallets.applicantId, id));
    return { applicant, wallets };
  });

  app.get('/jobs', async (req) => {
    const { status, wallet } = z
      .object({ status: z.enum(JOB_STATUSES).optional(), wallet: z.string().optional() })
      .parse(req.query);
    const where = status ? eq(schema.onchainJobs.status, status) : wallet ? eq(schema.onchainJobs.wallet, wallet) : undefined;
    return deps.db.select().from(schema.onchainJobs).where(where).orderBy(desc(schema.onchainJobs.id)).limit(100);
  });

  app.post('/jobs/:id/retry', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    if (!(await retryJob(deps.db, id, now()))) throw new HttpError(409, 'not_failed', 'Only failed jobs can be retried');
    return { retried: true };
  });

  return app;
}
