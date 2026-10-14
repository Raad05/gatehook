import type { Address, GetAccountInfoApi, Rpc } from '@solana/kit';
import { fetchSysvarClock } from '@solana/sysvars';
import {
  type ComplianceConfig,
  fetchComplianceConfig,
  fetchMaybeIdentity,
  fetchRegistry,
  findConfigPda,
  findIdentityPda,
  type GatehookError,
  getGatehookErrorMessage,
  type Identity,
  type Registry,
  Tier,
  GATEHOOK_ERROR__AMOUNT_EXCEEDS_MAX,
  GATEHOOK_ERROR__GLOBAL_LOCKUP,
  GATEHOOK_ERROR__HOLDER_LOCKUP,
  GATEHOOK_ERROR__PAUSED,
  GATEHOOK_ERROR__RECIPIENT_FROZEN,
  GATEHOOK_ERROR__RECIPIENT_IDENTITY_NOT_FOUND,
  GATEHOOK_ERROR__RECIPIENT_JURISDICTION_NOT_ALLOWED,
  GATEHOOK_ERROR__RECIPIENT_KYC_EXPIRED,
  GATEHOOK_ERROR__RECIPIENT_TIER_NOT_ALLOWED,
  GATEHOOK_ERROR__REG_S_RESTRICTED,
  GATEHOOK_ERROR__SENDER_FROZEN,
  GATEHOOK_ERROR__SENDER_IDENTITY_NOT_FOUND,
  GATEHOOK_ERROR__SENDER_JURISDICTION_NOT_ALLOWED,
  GATEHOOK_ERROR__SENDER_KYC_EXPIRED,
  GATEHOOK_ERROR__SENDER_TIER_NOT_ALLOWED,
  GATEHOOK_ERROR__VELOCITY_LIMIT_EXCEEDED,
  JURISDICTION_US,
} from './generated/index.ts';
import { isJurisdictionAllowed, isTierAllowed } from './rules.ts';

export type PreflightInput = {
  config: ComplianceConfig;
  registry: Registry;
  /** `null` when the sender's identity account does not exist. */
  sender: Identity | null;
  recipient: Identity | null;
  sourceOwner: Address;
  destinationOwner: Address;
  /** Signer of the transfer (owner or delegate). */
  authority: Address;
  amount: bigint;
  /** Cluster unix timestamp. */
  now: bigint;
};

export type PreflightResult =
  | { ok: true; forced: boolean }
  | { ok: false; code: GatehookError; message: string };

const reject = (code: GatehookError): PreflightResult => ({ ok: false, code, message: getGatehookErrorMessage(code) });

const SENDER_ERRORS = [
  GATEHOOK_ERROR__SENDER_FROZEN,
  GATEHOOK_ERROR__SENDER_KYC_EXPIRED,
  GATEHOOK_ERROR__SENDER_TIER_NOT_ALLOWED,
  GATEHOOK_ERROR__SENDER_JURISDICTION_NOT_ALLOWED,
] as const;
const RECIPIENT_ERRORS = [
  GATEHOOK_ERROR__RECIPIENT_FROZEN,
  GATEHOOK_ERROR__RECIPIENT_KYC_EXPIRED,
  GATEHOOK_ERROR__RECIPIENT_TIER_NOT_ALLOWED,
  GATEHOOK_ERROR__RECIPIENT_JURISDICTION_NOT_ALLOWED,
] as const;

/**
 * Off-chain mirror of the hook's `execute`, in the same order, returning the
 * error the transfer would fail with. Use for UX; the chain is authoritative.
 */
export function preflightTransfer(input: PreflightInput): PreflightResult {
  const { config, registry, sender, recipient, amount, now } = input;
  const rules = config.rules;

  if (input.authority === registry.admin && input.authority !== input.sourceOwner) {
    return { ok: true, forced: true };
  }
  if (!sender || sender.registry !== config.registry || sender.wallet !== input.sourceOwner) {
    return reject(GATEHOOK_ERROR__SENDER_IDENTITY_NOT_FOUND);
  }
  if (!recipient || recipient.registry !== config.registry || recipient.wallet !== input.destinationOwner) {
    return reject(GATEHOOK_ERROR__RECIPIENT_IDENTITY_NOT_FOUND);
  }
  if (config.paused) return reject(GATEHOOK_ERROR__PAUSED);
  if (rules.maxTxAmount > 0n && amount > rules.maxTxAmount) return reject(GATEHOOK_ERROR__AMOUNT_EXCEEDS_MAX);

  for (const [holder, [frozen, expired, tier, jurisdiction]] of [
    [sender, SENDER_ERRORS],
    [recipient, RECIPIENT_ERRORS],
  ] as const) {
    if (holder.frozen) return reject(frozen);
    if (holder.kycExpiry <= now) return reject(expired);
    if (!isTierAllowed(rules, holder.tier)) return reject(tier);
    if (!isJurisdictionAllowed(rules, holder.jurisdiction)) return reject(jurisdiction);
  }

  if (sender.tier === Tier.RegSNonUs && now < rules.regSComplianceUntil && recipient.jurisdiction === JURISDICTION_US) {
    return reject(GATEHOOK_ERROR__REG_S_RESTRICTED);
  }
  if (sender.tier !== Tier.Issuer) {
    if (now < rules.lockupUntil) return reject(GATEHOOK_ERROR__GLOBAL_LOCKUP);
    if (now < sender.lockupUntil) return reject(GATEHOOK_ERROR__HOLDER_LOCKUP);
  }

  const limit = rules.velocityLimitPerTier[sender.tier] ?? 0n;
  if (limit > 0n) {
    const windowExpired = now - sender.windowStart >= rules.velocityWindowSecs;
    const volume = (windowExpired ? 0n : sender.windowVolume) + amount;
    if (volume > limit) return reject(GATEHOOK_ERROR__VELOCITY_LIMIT_EXCEEDED);
  }
  return { ok: true, forced: false };
}

export type PreflightFromChainInput = {
  mint: Address;
  sourceOwner: Address;
  destinationOwner: Address;
  authority?: Address;
  amount: bigint;
};

/** Fetches config, registry, identities and clock, then runs `preflightTransfer`. */
export async function preflightTransferFromChain(
  rpc: Rpc<GetAccountInfoApi>,
  input: PreflightFromChainInput,
): Promise<PreflightResult> {
  const [configAddress] = await findConfigPda({ mint: input.mint });
  const config = await fetchComplianceConfig(rpc, configAddress);
  const [[senderAddress], [recipientAddress]] = await Promise.all([
    findIdentityPda({ registry: config.data.registry, wallet: input.sourceOwner }),
    findIdentityPda({ registry: config.data.registry, wallet: input.destinationOwner }),
  ]);
  const [registry, sender, recipient, clock] = await Promise.all([
    fetchRegistry(rpc, config.data.registry),
    fetchMaybeIdentity(rpc, senderAddress),
    fetchMaybeIdentity(rpc, recipientAddress),
    fetchSysvarClock(rpc),
  ]);
  return preflightTransfer({
    config: config.data,
    registry: registry.data,
    sender: sender.exists ? sender.data : null,
    recipient: recipient.exists ? recipient.data : null,
    sourceOwner: input.sourceOwner,
    destinationOwner: input.destinationOwner,
    authority: input.authority ?? input.sourceOwner,
    amount: input.amount,
    now: clock.unixTimestamp,
  });
}
