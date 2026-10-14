// Seeds demo holders for the mint from create-mint:
//   treasury (issuer, Tier.Issuer) - receives the initial supply
//   alice    US, Reg D accredited
//   bob      DE, Reg S
//   mallory  no identity (KYC never completed)
//
//   CLUSTER=localnet pnpm seed
import { getUpsertIdentityInstructionAsync, jurisdictionIndex, Tier } from '@gatehook/sdk';
import type { Address, Instruction } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import {
  type DemoHolder,
  fund,
  loadIssuer,
  loadOracle,
  newDemoHolder,
  readState,
  requireState,
  send,
  writeState,
} from './lib.ts';

const state = readState();
const { mint, registry, decimals } = requireState(state, 'mint', 'registry', 'decimals');
const issuer = await loadIssuer();
const oracle = await loadOracle();
const ONE_YEAR = 365n * 86_400n;
const now = BigInt(Math.floor(Date.now() / 1000));

async function ata(owner: Address) {
  const [address] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  return {
    address,
    create: await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: issuer,
      owner,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
  };
}

async function attest(wallet: Address, tier: Tier, jurisdiction: string) {
  return getUpsertIdentityInstructionAsync({
    oracle,
    payer: issuer,
    registry,
    wallet,
    tier,
    jurisdiction: jurisdictionIndex(jurisdiction),
    kycExpiry: now + ONE_YEAR,
    lockupUntil: 0n,
  });
}

// Issuer pays all fees and rent; the oracle co-signs attestations.
// Treasury: issuer's own ATA + Issuer-tier identity, then mint supply.
const treasury = await ata(issuer.address);
const supply = 10_000_000n * 10n ** BigInt(decimals);
await send(issuer, [
  treasury.create,
  await attest(issuer.address, Tier.Issuer, 'US'),
  getMintToInstruction({ mint, token: treasury.address, mintAuthority: issuer, amount: supply }),
]);
console.log(`treasury ${treasury.address} minted ${supply}`);

const holders: DemoHolder[] = [];
const profiles = [
  { name: 'alice', tier: Tier.RegDAccredited, jurisdiction: 'US' },
  { name: 'bob', tier: Tier.RegSNonUs, jurisdiction: 'DE' },
  { name: 'mallory', tier: null, jurisdiction: null },
] as const;

for (const profile of profiles) {
  const { holder, signer } = await newDemoHolder(profile.name);
  await fund(issuer, signer.address, 0.05);
  const account = await ata(signer.address);
  const ixs: Instruction[] = [account.create];
  if (profile.tier !== null) ixs.push(await attest(signer.address, profile.tier, profile.jurisdiction));
  await send(issuer, ixs);
  holders.push(holder);
  console.log(`${profile.name} ${signer.address} ata ${account.address}${profile.tier === null ? ' (no identity)' : ''}`);
}

writeState({ ...state, holders });
