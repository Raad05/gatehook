// Writes (or expires) one wallet's identity directly with the oracle key,
// without running the oracle service. Optionally sends it tokens from the
// issuer's treasury so it can try transfers right away.
//
//   CLUSTER=devnet pnpm attest --wallet <address> [--tier accredited|non_us|qualified_purchaser|issuer|venue]
//                              [--country US] [--days 365] [--lockup-days 0] [--expire] [--send 10]
import {
  fetchMaybeIdentity,
  findIdentityPda,
  getCompliantTransferInstruction,
  getUpsertIdentityInstructionAsync,
  jurisdictionCode,
  jurisdictionIndex,
  Tier,
} from '@gatehook/sdk';
import { address, type Address } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { arg, explorer, loadIssuer, loadOracle, readState, rpc, send } from './lib.ts';

const TIERS: Record<string, Tier> = {
  accredited: Tier.RegDAccredited,
  non_us: Tier.RegSNonUs,
  qualified_purchaser: Tier.QualifiedPurchaser,
  issuer: Tier.Issuer,
  venue: Tier.Venue,
};

const walletArg = arg('wallet');
if (!walletArg) throw new Error('--wallet <address> is required');
const wallet = address(walletArg);
const state = readState();
const registryArg = arg('registry') ?? state.registry;
if (!registryArg) throw new Error('--registry is required (or run create-mint first)');
const registry = address(registryArg);

const oracle = await loadOracle();
const issuer = await loadIssuer();
const [identityAddress] = await findIdentityPda({ registry, wallet });
const current = await fetchMaybeIdentity(rpc, identityAddress);
const now = BigInt(Math.floor(Date.now() / 1000));
const DAY = 86_400n;

let params;
if (process.argv.includes('--expire')) {
  // Same semantics as the oracle: keep the record (and any freeze), expire the KYC.
  if (!current.exists) throw new Error(`${wallet} has no identity to expire`);
  params = { tier: current.data.tier, jurisdiction: current.data.jurisdiction, kycExpiry: 0n, lockupUntil: current.data.lockupUntil };
} else {
  const tierName = arg('tier', 'accredited')!;
  const tier = TIERS[tierName];
  if (tier === undefined) throw new Error(`--tier must be one of ${Object.keys(TIERS).join(', ')}`);
  params = {
    tier,
    jurisdiction: jurisdictionIndex(arg('country', 'US')!),
    kycExpiry: now + BigInt(arg('days', '365')!) * DAY,
    lockupUntil: BigInt(arg('lockup-days', '0')!) > 0n ? now + BigInt(arg('lockup-days')!) * DAY : 0n,
  };
}

const sig = await send(oracle, [
  await getUpsertIdentityInstructionAsync({ oracle, payer: oracle, registry, wallet, ...params }),
]);
console.log(
  `${wallet}: tier ${Tier[params.tier]}, ${jurisdictionCode(params.jurisdiction)}, ` +
    `KYC ${params.kycExpiry === 0n ? 'expired' : `until ${new Date(Number(params.kycExpiry) * 1000).toISOString()}`}` +
    `${current.exists && current.data.frozen ? ' (FROZEN by admin)' : ''}\n  ${explorer(sig)}`,
);

const amount = arg('send');
if (amount) {
  const { mint, decimals } = state;
  if (!mint || decimals === undefined) throw new Error('--send needs a mint in demo state (run create-mint + seed)');
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
  const units = BigInt(Math.round(Number(amount) * 10 ** decimals));
  const transferSig = await send(issuer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: issuer, owner: wallet, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    await getCompliantTransferInstruction({
      source: await ata(issuer.address),
      destination: await ata(wallet),
      mint,
      authority: issuer,
      destinationOwner: wallet,
      registry,
      amount: units,
      decimals,
    }),
  ]);
  console.log(`sent ${amount} tokens from treasury: ${explorer(transferSig)}`);
}
