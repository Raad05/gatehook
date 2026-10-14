// Creates the issuer registry (if needed) and a compliant RWA mint:
// Token-2022 with TransferHook -> gatehook, PermanentDelegate (clawback),
// MetadataPointer + TokenMetadata; then its ComplianceConfig and extra metas.
//
//   CLUSTER=localnet pnpm create-mint --name "T-Bill 2027" --symbol TB27
import {
  buildComplianceRules,
  fetchMaybeRegistry,
  findRegistryPda,
  GATEHOOK_PROGRAM_ADDRESS,
  getInitExtraAccountMetasInstructionAsync,
  getInitMintConfigInstructionAsync,
  getInitRegistryInstructionAsync,
  Tier,
} from '@gatehook/sdk';
import { generateKeyPairSigner, some } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  type ExtensionArgs,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializePermanentDelegateInstruction,
  getInitializeTokenMetadataInstruction,
  getInitializeTransferHookInstruction,
  getMintSize,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { arg, cluster, explorer, loadIssuer, loadOracle, readState, rpc, send, writeState } from './lib.ts';

const DECIMALS = 6;
const name = arg('name', 'Gatehook Demo T-Bill')!;
const symbol = arg('symbol', 'GTB')!;
const uri = arg('uri', '')!;

const issuer = await loadIssuer();
const oracle = await loadOracle();
console.log(`cluster ${cluster}, issuer ${issuer.address}, oracle ${oracle.address}`);

// 1. Registry (one per issuer).
const [registry] = await findRegistryPda({ issuer: issuer.address });
if (!(await fetchMaybeRegistry(rpc, registry)).exists) {
  const sig = await send(issuer, [await getInitRegistryInstructionAsync({ issuer, oracle: oracle.address })]);
  console.log(`registry ${registry} created: ${explorer(sig)}`);
} else {
  console.log(`registry ${registry} exists`);
}

// 2. Mint. Account is created at fixed-extension size; TokenMetadata is
// variable-length and reallocated by its initialize ix, so fund for both.
const mint = await generateKeyPairSigner();
const fixedExtensions: ExtensionArgs[] = [
  { __kind: 'TransferHook', authority: issuer.address, programId: GATEHOOK_PROGRAM_ADDRESS },
  { __kind: 'PermanentDelegate', delegate: issuer.address },
  { __kind: 'MetadataPointer', authority: some(issuer.address), metadataAddress: some(mint.address) },
];
const space = getMintSize(fixedExtensions);
const fullSpace = getMintSize([
  ...fixedExtensions,
  {
    __kind: 'TokenMetadata',
    updateAuthority: some(issuer.address),
    mint: mint.address,
    name,
    symbol,
    uri,
    additionalMetadata: new Map(),
  },
]);
const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(fullSpace)).send();

const mintSig = await send(issuer, [
  getCreateAccountInstruction({ payer: issuer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
  getInitializeTransferHookInstruction({ mint: mint.address, authority: issuer.address, programId: GATEHOOK_PROGRAM_ADDRESS }),
  getInitializePermanentDelegateInstruction({ mint: mint.address, delegate: issuer.address }),
  getInitializeMetadataPointerInstruction({ mint: mint.address, authority: issuer.address, metadataAddress: mint.address }),
  getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: issuer.address }),
  getInitializeTokenMetadataInstruction({
    metadata: mint.address,
    updateAuthority: issuer.address,
    mint: mint.address,
    mintAuthority: issuer,
    name,
    symbol,
    uri,
  }),
]);
console.log(`mint ${mint.address} created: ${explorer(mintSig)}`);

// 3. Compliance config + extra account metas. Demo rules: US/DE/GB/SG,
// all investor tiers, 30-day Reg S period, 1M/day velocity for Reg D.
const now = BigInt(Math.floor(Date.now() / 1000));
const rules = buildComplianceRules({
  jurisdictions: ['US', 'DE', 'GB', 'SG'],
  tiers: [Tier.RegDAccredited, Tier.RegSNonUs, Tier.QualifiedPurchaser, Tier.Issuer, Tier.Venue],
  regSComplianceUntil: now + 30n * 86_400n,
  velocityWindowSecs: 86_400n,
  velocityLimits: { [Tier.RegDAccredited]: 1_000_000n * 10n ** BigInt(DECIMALS) },
});
const configSig = await send(issuer, [
  await getInitMintConfigInstructionAsync({ admin: issuer, registry, mint: mint.address, rules }),
  await getInitExtraAccountMetasInstructionAsync({ admin: issuer, registry, mint: mint.address }),
]);
console.log(`config + extra metas: ${explorer(configSig)}`);

writeState({ ...readState(), mint: mint.address, registry, decimals: DECIMALS, holders: [] });
