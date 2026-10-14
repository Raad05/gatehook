import type { ComplianceRulesArgs } from './generated/index.ts';
import { Tier } from './generated/index.ts';
import { jurisdictionIndex } from './jurisdictions.ts';

/** Number of `Tier` variants; length of `velocityLimitPerTier`. */
export const N_TIERS = 6;

export type RulesInput = {
  /** Max amount per transfer in base units; omitted/0 = no cap. */
  maxTxAmount?: bigint;
  velocityWindowSecs?: bigint;
  /** Max volume per window per tier; omitted/0 = no limit. */
  velocityLimits?: Partial<Record<Tier, bigint>>;
  /** Unix timestamp; no transfers before it (issuer tier exempt). */
  lockupUntil?: bigint;
  /** Unix timestamp; until then Reg S holders cannot send to US persons. */
  regSComplianceUntil?: bigint;
  /** ISO 3166-1 alpha-2 codes allowed to hold and transfer. */
  jurisdictions: readonly string[];
  tiers: readonly Tier[];
};

/** Builds on-chain `ComplianceRules`, validating like the program does. */
export function buildComplianceRules(input: RulesInput): ComplianceRulesArgs {
  const velocityLimitPerTier = Array.from({ length: N_TIERS }, (_, tier) => input.velocityLimits?.[tier as Tier] ?? 0n);
  const velocityWindowSecs = input.velocityWindowSecs ?? 0n;
  if (velocityLimitPerTier.some((l) => l > 0n) && velocityWindowSecs <= 0n) {
    throw new Error('velocityWindowSecs must be positive when a velocity limit is set');
  }
  if (input.tiers.includes(Tier.None)) throw new Error('Tier.None can never be allowed');
  return {
    maxTxAmount: input.maxTxAmount ?? 0n,
    velocityWindowSecs,
    velocityLimitPerTier,
    lockupUntil: input.lockupUntil ?? 0n,
    regSComplianceUntil: input.regSComplianceUntil ?? 0n,
    allowedJurisdictions: jurisdictionBitmap(input.jurisdictions.map(jurisdictionIndex)),
    allowedTiers: input.tiers.reduce((bits, tier) => bits | (1 << tier), 0),
  };
}

/** 256-bit bitmap as four little-endian u64 words. */
export function jurisdictionBitmap(indices: readonly number[]): bigint[] {
  const words = [0n, 0n, 0n, 0n];
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 1 || index > 255) throw new Error(`Invalid jurisdiction index: ${index}`);
    words[index >> 6]! |= 1n << BigInt(index & 63);
  }
  return words;
}

type RulesLike = { allowedJurisdictions: readonly (bigint | number)[]; allowedTiers: number };

export function isJurisdictionAllowed(rules: RulesLike, index: number): boolean {
  if (index === 0) return false;
  const word = BigInt(rules.allowedJurisdictions[index >> 6] ?? 0n);
  return ((word >> BigInt(index & 63)) & 1n) === 1n;
}

export function isTierAllowed(rules: RulesLike, tier: Tier): boolean {
  return tier !== Tier.None && ((rules.allowedTiers >> tier) & 1) === 1;
}
