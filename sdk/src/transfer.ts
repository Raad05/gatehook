import { AccountRole, type AccountMeta, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token-2022';
import {
  findConfigPda,
  findExtraAccountMetaListPda,
  findIdentityPda,
  GATEHOOK_PROGRAM_ADDRESS,
} from './generated/index.ts';

export type HookAccountsInput = {
  mint: Address;
  /** The mint's registry (`ComplianceConfig.registry`). */
  registry: Address;
  /** Owner of the source token account (not the delegate). */
  sourceOwner: Address;
  /** Owner of the destination token account. */
  destinationOwner: Address;
  programAddress?: Address;
};

/**
 * Extra accounts Token-2022 must forward to the hook, in the order its
 * `ExtraAccountMetaList` resolves them, followed by the hook program and the
 * validation account. Pure derivation; no RPC calls.
 */
export async function getHookExtraAccountMetas(input: HookAccountsInput): Promise<AccountMeta[]> {
  const programAddress = input.programAddress ?? GATEHOOK_PROGRAM_ADDRESS;
  const cfg = { programAddress };
  const [[config], [senderIdentity], [recipientIdentity], [extraMetas]] = await Promise.all([
    findConfigPda({ mint: input.mint }, cfg),
    findIdentityPda({ registry: input.registry, wallet: input.sourceOwner }, cfg),
    findIdentityPda({ registry: input.registry, wallet: input.destinationOwner }, cfg),
    findExtraAccountMetaListPda({ mint: input.mint }, cfg),
  ]);
  return [
    { address: config, role: AccountRole.READONLY },
    { address: input.registry, role: AccountRole.READONLY },
    { address: senderIdentity, role: AccountRole.WRITABLE },
    { address: recipientIdentity, role: AccountRole.READONLY },
    { address: programAddress, role: AccountRole.READONLY },
    { address: extraMetas, role: AccountRole.READONLY },
  ];
}

export type CompliantTransferInput = Omit<HookAccountsInput, 'sourceOwner'> & {
  source: Address;
  destination: Address;
  /** Owner or delegate signing the transfer. */
  authority: TransactionSigner;
  /** Defaults to `authority.address`; set when a delegate signs. */
  sourceOwner?: Address;
  amount: bigint;
  decimals: number;
};

/**
 * `transferChecked` with the hook's extra accounts appended, built offline.
 * Equivalent to `getTransferCheckedWithTransferHookInstructionAsync` from
 * `@solana-program/token-2022` (which reads the validation account over RPC).
 */
export async function getCompliantTransferInstruction(input: CompliantTransferInput): Promise<Instruction> {
  const base = getTransferCheckedInstruction({
    source: input.source,
    mint: input.mint,
    destination: input.destination,
    authority: input.authority,
    amount: input.amount,
    decimals: input.decimals,
  });
  const extras = await getHookExtraAccountMetas({
    ...input,
    sourceOwner: input.sourceOwner ?? input.authority.address,
  });
  return { ...base, accounts: [...base.accounts, ...extras] };
}
