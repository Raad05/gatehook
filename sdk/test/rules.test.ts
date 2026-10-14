import { describe, expect, it } from 'vitest';
import {
  buildComplianceRules,
  isJurisdictionAllowed,
  isTierAllowed,
  jurisdictionBitmap,
  jurisdictionCode,
  jurisdictionIndex,
  JURISDICTION_US,
  JURISDICTIONS,
  Tier,
} from '../src/index.ts';

describe('jurisdictions', () => {
  it('matches the program constants and fits the 256-bit bitmap', () => {
    expect(JURISDICTIONS[0]).toBe('');
    expect(jurisdictionIndex('US')).toBe(JURISDICTION_US);
    expect(JURISDICTIONS.length).toBeLessThanOrEqual(256);
    expect(new Set(JURISDICTIONS).size).toBe(JURISDICTIONS.length);
  });

  it('covers all 249 ISO 3166-1 alpha-2 codes', () => {
    expect(JURISDICTIONS.length - 1).toBe(249);
    for (const code of JURISDICTIONS.slice(1)) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it('round-trips and rejects unknown codes', () => {
    expect(jurisdictionCode(jurisdictionIndex('de'))).toBe('DE');
    expect(jurisdictionCode(0)).toBeUndefined();
    expect(() => jurisdictionIndex('XX')).toThrow();
    expect(() => jurisdictionIndex('')).toThrow();
  });
});

describe('rules', () => {
  it('encodes bitmaps with the same layout as the program', () => {
    expect(jurisdictionBitmap([1, 63, 64, 255])).toEqual([(1n << 1n) | (1n << 63n), 1n, 0n, 1n << 63n]);
    expect(() => jurisdictionBitmap([0])).toThrow();
    expect(() => jurisdictionBitmap([256])).toThrow();
  });

  it('builds rules and answers allow checks', () => {
    const rules = buildComplianceRules({
      jurisdictions: ['US', 'ZW'],
      tiers: [Tier.RegDAccredited, Tier.Venue],
      velocityWindowSecs: 86_400n,
      velocityLimits: { [Tier.RegDAccredited]: 1_000n },
    });
    expect(rules.velocityLimitPerTier).toEqual([0n, 1_000n, 0n, 0n, 0n, 0n]);
    expect(rules.allowedTiers).toBe(0b10_0010);
    expect(isJurisdictionAllowed(rules, jurisdictionIndex('ZW'))).toBe(true);
    expect(isJurisdictionAllowed(rules, jurisdictionIndex('DE'))).toBe(false);
    expect(isJurisdictionAllowed(rules, 0)).toBe(false);
    expect(isTierAllowed(rules, Tier.Venue)).toBe(true);
    expect(isTierAllowed(rules, Tier.Issuer)).toBe(false);
  });

  it('rejects what the program would reject', () => {
    expect(() =>
      buildComplianceRules({ jurisdictions: [], tiers: [], velocityLimits: { [Tier.RegDAccredited]: 1n } }),
    ).toThrow(/velocityWindowSecs/);
    expect(() => buildComplianceRules({ jurisdictions: [], tiers: [Tier.None] })).toThrow();
  });
});
