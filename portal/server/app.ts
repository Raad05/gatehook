import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { MockKycProvider } from '@gatehook/oracle/providers/mock';
import { isAddress } from '@solana/kit';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PortalConfig } from './config.ts';
import { OracleClient, OracleError } from './oracle-client.ts';

type Session = { email: string; applicantId: string };

export type PortalDeps = {
  config: PortalConfig;
  oracle: OracleClient;
  /** Issuer signer for the demo faucet, if enabled. */
  faucet?: (wallet: string) => Promise<unknown>;
  staticDir?: string;
  logger?: boolean;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Applicant ids are derived from the (demo) login so a re-login finds the same applicant. */
export const applicantIdFor = (email: string) =>
  `portal-${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)}`;

export function buildPortal(deps: PortalDeps) {
  const app = Fastify({ logger: deps.logger ?? false });
  // DEMO: in-memory sessions. Replace with the issuer's real investor auth.
  const sessions = new Map<string, Session>();
  const mock = deps.config.DEMO_MOCK_WEBHOOK_SECRET ? new MockKycProvider(deps.config.DEMO_MOCK_WEBHOOK_SECRET) : null;

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError || error instanceof OracleError) {
      return reply.status(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_request', message: z.prettifyError(error) });
    req.log.error(error);
    return reply.status(500).send({ error: 'internal', message: 'Internal error' });
  });

  const session = (req: FastifyRequest): Session => {
    const header = req.headers.authorization;
    const found = header?.startsWith('Bearer ') ? sessions.get(header.slice(7)) : undefined;
    if (!found) throw new ApiError(401, 'unauthorized', 'Sign in first');
    return found;
  };
  const walletOf = (value: string) => {
    if (!isAddress(value)) throw new ApiError(400, 'invalid_wallet', 'Not a valid Solana address');
    return value;
  };

  app.get('/api/config', async () => ({
    cluster: deps.config.CLUSTER,
    rpcUrl: deps.config.rpcUrl,
    mint: deps.config.PORTAL_MINT,
    demoKyc: mock !== null,
    demoFaucet: deps.faucet !== undefined,
  }));

  /** DEMO login: any email. Returns a bearer token. */
  app.post('/api/session', async (req) => {
    const { email } = z.object({ email: z.email() }).parse(req.body);
    const token = randomBytes(32).toString('hex');
    const value = { email, applicantId: applicantIdFor(email) };
    sessions.set(token, value);
    return { token, ...value };
  });

  app.get('/api/status', async (req) => {
    const { email, applicantId } = session(req);
    const record = await deps.oracle.applicant(applicantId);
    const wallets = await Promise.all(
      (record?.wallets ?? []).map(async (w) => ({ ...w, job: (await deps.oracle.jobs(w.address))[0] ?? null })),
    );
    return { email, applicantId, applicant: record?.applicant ?? null, wallets };
  });

  /** DEMO KYC: stands in for the provider's webhook. */
  app.post('/api/kyc', async (req) => {
    if (!mock) throw new ApiError(404, 'demo_kyc_disabled', 'Demo KYC is not enabled');
    const { applicantId } = session(req);
    const body = z
      .object({
        status: z.enum(['approved', 'rejected', 'revoked']).default('approved'),
        tier: z.enum(['accredited', 'non_us', 'qualified_purchaser']).default('accredited'),
        country: z.string().length(2).default('US'),
      })
      .parse(req.body ?? {});
    const raw = JSON.stringify({
      eventId: randomUUID(),
      applicantId,
      status: body.status,
      ...(body.status === 'approved' ? { tier: body.tier, country: body.country.toUpperCase() } : {}),
      reviewedAt: new Date().toISOString(),
    });
    return deps.oracle.webhook(raw, mock.sign(raw, Date.now()));
  });

  app.post('/api/wallet/challenge', async (req) => {
    const { applicantId } = session(req);
    const { wallet } = z.object({ wallet: z.string() }).parse(req.body);
    return deps.oracle.challenge(walletOf(wallet), applicantId);
  });

  app.post('/api/wallet/link', async (req) => {
    session(req);
    const body = z.object({ wallet: z.string(), nonce: z.string().min(1), signature: z.string().min(1) }).parse(req.body);
    return deps.oracle.link(walletOf(body.wallet), body.nonce, body.signature);
  });

  /** DEMO faucet: only for wallets linked to the signed-in applicant. */
  app.post('/api/demo/faucet', async (req) => {
    if (!deps.faucet) throw new ApiError(404, 'faucet_disabled', 'Demo faucet is not enabled');
    const { applicantId } = session(req);
    const { wallet } = z.object({ wallet: z.string() }).parse(req.body);
    const record = await deps.oracle.applicant(applicantId);
    if (!record?.wallets.some((w) => w.address === walletOf(wallet))) {
      throw new ApiError(403, 'wallet_not_linked', 'Link this wallet first');
    }
    try {
      return await deps.faucet(wallet);
    } catch (error) {
      // Usually the hook rejecting the transfer (identity not on-chain yet) or an empty treasury.
      throw new ApiError(502, 'faucet_failed', error instanceof Error ? error.message : String(error));
    }
  });

  if (deps.staticDir && existsSync(deps.staticDir)) {
    void app.register(fastifyStatic, { root: deps.staticDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.status(404).send({ error: 'not_found' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}

