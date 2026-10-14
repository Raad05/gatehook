import { randomBytes } from 'node:crypto';
import {
  address,
  getBase58Encoder,
  getPublicKeyFromAddress,
  getUtf8Encoder,
  isAddress,
  type SignatureBytes,
  verifySignature,
} from '@solana/kit';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { schema } from '../db/client.ts';
import { HttpError } from '../errors.ts';
import { audit } from './audit.ts';
import { enqueueReconcile } from './jobs.ts';

const CHALLENGE_TTL_MS = 10 * 60_000;

export function linkMessage(applicantId: string, wallet: string, nonce: string, expiresAt: Date): string {
  return [
    'Gatehook wallet link',
    `Applicant: ${applicantId}`,
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join('\n');
}

function assertWallet(wallet: string) {
  if (!isAddress(wallet)) throw new HttpError(400, 'invalid_wallet', 'Not a valid Solana address');
}

/** Step 1: issue a one-time message for the wallet to sign. */
export async function createChallenge(db: Db, input: { applicantId: string; wallet: string; now: Date }) {
  assertWallet(input.wallet);
  const [applicant] = await db.select().from(schema.applicants).where(eq(schema.applicants.id, input.applicantId));
  if (!applicant) throw new HttpError(404, 'unknown_applicant', 'Applicant not found');
  const [linked] = await db.select().from(schema.wallets).where(eq(schema.wallets.address, input.wallet));
  if (linked && linked.applicantId !== input.applicantId) {
    throw new HttpError(409, 'wallet_taken', 'Wallet is linked to another applicant');
  }

  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(input.now.getTime() + CHALLENGE_TTL_MS);
  const message = linkMessage(input.applicantId, input.wallet, nonce, expiresAt);
  await db.insert(schema.linkChallenges).values({ nonce, applicantId: input.applicantId, wallet: input.wallet, message, expiresAt });
  return { nonce, message, expiresAt };
}

/** Step 2: verify the wallet's ed25519 signature over the challenge and link it. */
export async function completeLink(db: Db, input: { wallet: string; nonce: string; signature: string; now: Date }) {
  assertWallet(input.wallet);
  const [challenge] = await db.select().from(schema.linkChallenges).where(eq(schema.linkChallenges.nonce, input.nonce));
  if (!challenge || challenge.wallet !== input.wallet) throw new HttpError(400, 'invalid_challenge', 'Unknown challenge');
  if (challenge.usedAt) throw new HttpError(400, 'challenge_used', 'Challenge already used');
  if (challenge.expiresAt <= input.now) throw new HttpError(400, 'challenge_expired', 'Challenge expired');

  let signature: SignatureBytes;
  try {
    signature = getBase58Encoder().encode(input.signature) as SignatureBytes;
  } catch {
    throw new HttpError(400, 'invalid_signature', 'Signature must be base58');
  }
  const key = await getPublicKeyFromAddress(address(input.wallet));
  const valid =
    signature.length === 64 && (await verifySignature(key, signature, getUtf8Encoder().encode(challenge.message)));
  if (!valid) throw new HttpError(400, 'invalid_signature', 'Signature does not match wallet');

  return db.transaction(async (tx) => {
    const used = await tx
      .update(schema.linkChallenges)
      .set({ usedAt: input.now })
      .where(and(eq(schema.linkChallenges.nonce, input.nonce), isNull(schema.linkChallenges.usedAt)))
      .returning();
    // Conditional update makes the nonce single-use even under concurrent requests.
    if (used.length === 0) throw new HttpError(400, 'challenge_used', 'Challenge already used');

    const [existing] = await tx.select().from(schema.wallets).where(eq(schema.wallets.address, input.wallet));
    if (existing && existing.applicantId !== challenge.applicantId) {
      throw new HttpError(409, 'wallet_taken', 'Wallet is linked to another applicant');
    }
    if (!existing) await tx.insert(schema.wallets).values({ address: input.wallet, applicantId: challenge.applicantId });
    await enqueueReconcile(tx, input.wallet, input.now);
    await audit(tx, 'api', 'wallet_linked', challenge.applicantId, { wallet: input.wallet });
    return { applicantId: challenge.applicantId, wallet: input.wallet };
  });
}
