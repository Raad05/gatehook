import type { Tier } from '@gatehook/sdk';

export type KycStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

/** Provider-agnostic KYC decision for one applicant. */
export type KycDecision = {
  /** Provider event id; used for replay protection. */
  eventId: string;
  applicantId: string;
  status: KycStatus;
  /** Required when approved. */
  tier?: Tier;
  /** ISO 3166-1 alpha-2; required when approved. */
  country?: string;
  /** Provider-set expiry; defaults to reviewedAt + KYC_VALIDITY_DAYS. */
  expiresAt?: Date;
  /** Holding period end (e.g. Rule 144), if the issuer tracks it at KYC time. */
  lockupUntil?: Date;
  reviewedAt: Date;
};

export type Headers = Record<string, string | string[] | undefined>;

export interface KycProvider {
  readonly name: string;
  /** Throws `HttpError(401)` unless the webhook is authentic and fresh. */
  verify(headers: Headers, rawBody: string, now: Date): void;
  /** Throws `HttpError(400)` on malformed payloads. */
  parse(rawBody: string): KycDecision;
}
