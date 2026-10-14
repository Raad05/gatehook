import { createHmac, timingSafeEqual } from 'node:crypto';
import { Tier } from '@gatehook/sdk';
import { z } from 'zod';
import { HttpError } from '../errors.ts';
import type { Headers, KycDecision, KycProvider } from './types.ts';

const TOLERANCE_MS = 5 * 60_000;

const TIERS = {
  accredited: Tier.RegDAccredited,
  non_us: Tier.RegSNonUs,
  qualified_purchaser: Tier.QualifiedPurchaser,
} as const;

const payloadSchema = z.object({
  eventId: z.string().min(1),
  applicantId: z.string().min(1),
  status: z.enum(['pending', 'approved', 'rejected', 'revoked']),
  tier: z.enum(['accredited', 'non_us', 'qualified_purchaser']).optional(),
  country: z.string().length(2).optional(),
  expiresAt: z.iso.datetime().optional(),
  lockupUntil: z.iso.datetime().optional(),
  reviewedAt: z.iso.datetime(),
});

export type MockPayload = z.input<typeof payloadSchema>;

/**
 * Stand-in provider for development and tests. Webhooks are signed like
 * Stripe's: `x-mock-signature = hex(HMAC-SHA256(secret, "<timestamp>.<body>"))`
 * with `x-mock-timestamp` in unix milliseconds.
 */
export class MockKycProvider implements KycProvider {
  readonly name = 'mock';

  constructor(private readonly secret: string) {}

  sign(rawBody: string, timestampMs: number): Record<string, string> {
    const signature = createHmac('sha256', this.secret).update(`${timestampMs}.${rawBody}`).digest('hex');
    return { 'x-mock-signature': signature, 'x-mock-timestamp': String(timestampMs) };
  }

  verify(headers: Headers, rawBody: string, now: Date): void {
    const signature = headers['x-mock-signature'];
    const timestamp = Number(headers['x-mock-timestamp']);
    if (typeof signature !== 'string' || !Number.isFinite(timestamp)) {
      throw new HttpError(401, 'invalid_signature', 'Missing webhook signature');
    }
    if (Math.abs(now.getTime() - timestamp) > TOLERANCE_MS) {
      throw new HttpError(401, 'stale_webhook', 'Webhook timestamp outside tolerance');
    }
    const expected = Buffer.from(this.sign(rawBody, timestamp)['x-mock-signature']!, 'hex');
    const actual = Buffer.from(signature, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(401, 'invalid_signature', 'Invalid webhook signature');
    }
  }

  parse(rawBody: string): KycDecision {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new HttpError(400, 'invalid_payload', 'Body is not JSON');
    }
    const result = payloadSchema.safeParse(json);
    if (!result.success) throw new HttpError(400, 'invalid_payload', z.prettifyError(result.error));
    const p = result.data;
    return {
      eventId: p.eventId,
      applicantId: p.applicantId,
      status: p.status,
      tier: p.tier ? TIERS[p.tier] : undefined,
      country: p.country,
      expiresAt: p.expiresAt ? new Date(p.expiresAt) : undefined,
      lockupUntil: p.lockupUntil ? new Date(p.lockupUntil) : undefined,
      reviewedAt: new Date(p.reviewedAt),
    };
  }
}
