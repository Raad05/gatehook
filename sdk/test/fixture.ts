import type { Address, KeyPairSigner } from '@solana/kit';
import {
  buildComplianceRules,
  findRegistryPda,
  getInitExtraAccountMetasInstructionAsync,
  getInitMintConfigInstructionAsync,
  getInitRegistryInstructionAsync,
  getUpsertIdentityInstructionAsync,
  jurisdictionIndex,
  type RulesInput,
  Tier,
} from '../src/index.ts';
import { Svm } from './litesvm.ts';

export const NOW = 1_700_000_000n;
export const FAR_FUTURE = 4_000_000_000n;

export type Holder = { wallet: KeyPairSigner; token: Address };

export const DEFAULT_RULES: RulesInput = {
  jurisdictions: ['US', 'DE'],
  tiers: [Tier.RegDAccredited, Tier.RegSNonUs, Tier.QualifiedPurchaser, Tier.Issuer, Tier.Venue],
};

/** Registry + hook mint with config and extra metas, clock at `NOW`. */
export class Fixture {
  private constructor(
    readonly env: Svm,
    readonly issuer: KeyPairSigner,
    readonly oracle: KeyPairSigner,
    readonly registry: Address,
    readonly mint: Address,
  ) {}

  static async create(rules: RulesInput = DEFAULT_RULES, opts: { permanentDelegate?: boolean } = {}) {
    const env = new Svm();
    env.setTime(NOW);
    const issuer = await env.fundedSigner();
    const oracle = await env.fundedSigner();
    const [registry] = await findRegistryPda({ issuer: issuer.address });
    await env.sendOk(issuer, [await getInitRegistryInstructionAsync({ issuer, oracle: oracle.address })]);

    const mint = await env.createMint(issuer, issuer.address, opts.permanentDelegate ? issuer.address : undefined);
    await env.sendOk(issuer, [
      await getInitMintConfigInstructionAsync({ admin: issuer, registry, mint, rules: buildComplianceRules(rules) }),
      await getInitExtraAccountMetasInstructionAsync({ admin: issuer, registry, mint }),
    ]);
    return new Fixture(env, issuer, oracle, registry, mint);
  }

  async upsert(wallet: Address, opts: { tier?: Tier; jurisdiction?: string; kycExpiry?: bigint; lockupUntil?: bigint } = {}) {
    await this.env.sendOk(this.oracle, [
      await getUpsertIdentityInstructionAsync({
        oracle: this.oracle,
        payer: this.oracle,
        registry: this.registry,
        wallet,
        tier: opts.tier ?? Tier.RegDAccredited,
        jurisdiction: jurisdictionIndex(opts.jurisdiction ?? 'US'),
        kycExpiry: opts.kycExpiry ?? FAR_FUTURE,
        lockupUntil: opts.lockupUntil ?? 0n,
      }),
    ]);
  }

  async holder(balance = 0n, identity: Parameters<Fixture['upsert']>[1] | null = {}): Promise<Holder> {
    const wallet = await this.env.fundedSigner();
    const token = await this.env.createTokenAccount(this.issuer, this.mint, wallet.address);
    if (balance > 0n) await this.env.mintTo(this.issuer, this.mint, token, balance);
    if (identity) await this.upsert(wallet.address, identity);
    return { wallet, token };
  }
}
