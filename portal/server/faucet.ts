import { getCompliantTransferInstruction, fetchComplianceConfig, findConfigPda } from '@gatehook/sdk';
import {
  type Address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type KeyPairSigner,
  lamports,
  pipe,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type SolanaRpcApi,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';

/**
 * DEMO ONLY: gives a linked investor wallet a little SOL for fees and some
 * tokens from the issuer treasury. The token transfer goes through the hook,
 * so it only succeeds once the wallet's identity is on-chain.
 */
export async function runFaucet(rpc: Rpc<SolanaRpcApi>, issuer: KeyPairSigner, mint: Address, wallet: Address) {
  const [[configAddress], mintAccount] = await Promise.all([findConfigPda({ mint }), fetchMint(rpc, mint)]);
  const config = await fetchComplianceConfig(rpc, configAddress);
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
  const tokens = 100n * 10n ** BigInt(mintAccount.data.decimals);

  const instructions = [
    getTransferSolInstruction({ source: issuer, destination: wallet, amount: lamports(10_000_000n) }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: issuer, owner: wallet, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    await getCompliantTransferInstruction({
      source: await ata(issuer.address),
      destination: await ata(wallet),
      mint,
      authority: issuer,
      destinationOwner: wallet,
      registry: config.data.registry,
      amount: tokens,
      decimals: mintAccount.data.decimals,
    }),
  ];
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(issuer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  return { signature: getSignatureFromTransaction(tx), tokens: tokens.toString(), sol: '0.01' };
}
