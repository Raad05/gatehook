// On-chain reads and the compliant transfer, all via @gatehook/sdk.
import {
  fetchComplianceConfig,
  fetchMaybeIdentity,
  findConfigPda,
  findIdentityPda,
  getCompliantTransferInstruction,
  type Identity,
  preflightTransferFromChain,
  type PreflightResult,
} from '@gatehook/sdk';
import { type Address, address, createSolanaRpc, type Rpc, type SolanaRpcApi } from '@solana/kit';
import {
  fetchMaybeToken,
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import type { ActiveWallet } from './wallet.tsx';

export type TokenInfo = { mint: Address; registry: Address; decimals: number; name: string };
export type Holder = { sol: bigint; balance: bigint; identity: Identity | null };

export const makeRpc = (url: string): Rpc<SolanaRpcApi> => createSolanaRpc(url);

export async function loadToken(rpc: Rpc<SolanaRpcApi>, mintStr: string): Promise<TokenInfo> {
  const mint = address(mintStr);
  const [configAddress] = await findConfigPda({ mint });
  const [mintAccount, config] = await Promise.all([fetchMint(rpc, mint), fetchComplianceConfig(rpc, configAddress)]);
  const metadata = mintAccount.data.extensions.__option === 'Some'
    ? mintAccount.data.extensions.value.find((e) => e.__kind === 'TokenMetadata')
    : undefined;
  return {
    mint,
    registry: config.data.registry,
    decimals: mintAccount.data.decimals,
    name: metadata && 'symbol' in metadata ? `${metadata.name} (${metadata.symbol})` : mint,
  };
}

const ata = async (owner: Address, mint: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];

export async function loadHolder(rpc: Rpc<SolanaRpcApi>, token: TokenInfo, wallet: Address): Promise<Holder> {
  const [[identityAddress], tokenAccount] = await Promise.all([
    findIdentityPda({ registry: token.registry, wallet }),
    ata(wallet, token.mint),
  ]);
  const [identity, account, sol] = await Promise.all([
    fetchMaybeIdentity(rpc, identityAddress),
    fetchMaybeToken(rpc, tokenAccount),
    rpc.getBalance(wallet).send(),
  ]);
  return {
    sol: sol.value,
    balance: account.exists ? account.data.amount : 0n,
    identity: identity.exists ? identity.data : null,
  };
}

export function preflight(rpc: Rpc<SolanaRpcApi>, token: TokenInfo, from: Address, to: Address, amount: bigint): Promise<PreflightResult> {
  return preflightTransferFromChain(rpc, { mint: token.mint, sourceOwner: from, destinationOwner: to, amount });
}

/** Creates the recipient's token account if needed, then a hook-compliant transfer. */
export async function transfer(rpc: Rpc<SolanaRpcApi>, token: TokenInfo, wallet: ActiveWallet, to: Address, amount: bigint) {
  return wallet.send(rpc, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: wallet.signer,
      owner: to,
      mint: token.mint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    await getCompliantTransferInstruction({
      source: await ata(wallet.address, token.mint),
      destination: await ata(to, token.mint),
      mint: token.mint,
      authority: wallet.signer,
      destinationOwner: to,
      registry: token.registry,
      amount,
      decimals: token.decimals,
    }),
  ]);
}

export function parseAmount(input: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(input.trim())) return null;
  const [whole = '0', frac = ''] = input.trim().split('.');
  if (frac.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function formatAmount(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${(amount / base).toLocaleString()}${frac ? `.${frac}` : ''}`;
}

export function explorerTx(signature: string, cluster: string, rpcUrl: string) {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : `?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}
