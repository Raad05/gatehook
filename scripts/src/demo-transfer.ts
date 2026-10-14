// Demo: treasury -> alice (ok), alice -> bob (ok), alice -> mallory (rejected:
// no identity), shown via SDK preflight and then the real on-chain result.
//
//   CLUSTER=localnet pnpm demo-transfer
import {
  getCompliantTransferInstruction,
  getComplianceErrorMessage,
  preflightTransferFromChain,
} from '@gatehook/sdk';
import { type Address, isSolanaError, type KeyPairSigner } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { explorer, holderSigner, loadIssuer, readState, requireState, rpc, send } from './lib.ts';

const state = readState();
const { mint, registry, decimals, holders } = requireState(state, 'mint', 'registry', 'decimals', 'holders');
const issuer = await loadIssuer();
const byName = async (name: string) => {
  const holder = holders.find((h) => h.name === name);
  if (!holder) throw new Error(`holder ${name} missing; run seed`);
  return holderSigner(holder);
};
const [alice, bob, mallory] = await Promise.all(['alice', 'bob', 'mallory'].map(byName));
const ata = async (owner: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
const units = (n: bigint) => n * 10n ** BigInt(decimals);

/** Custom program error code from a failed send/simulation, if any. */
function customCode(error: unknown): number | undefined {
  let e: unknown = error;
  while (e) {
    if (isSolanaError(e) && typeof (e.context as { code?: unknown }).code === 'number') {
      return (e.context as { code: number }).code;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

async function transfer(label: string, from: KeyPairSigner, to: KeyPairSigner, amount: bigint) {
  console.log(`\n== ${label}: ${amount} base units`);
  const preflight = await preflightTransferFromChain(rpc, {
    mint,
    sourceOwner: from.address,
    destinationOwner: to.address,
    amount,
  });
  console.log(`preflight: ${preflight.ok ? 'ok' : `rejected - ${preflight.message}`}`);

  const ix = await getCompliantTransferInstruction({
    source: await ata(from.address),
    destination: await ata(to.address),
    mint,
    authority: from,
    destinationOwner: to.address,
    registry,
    amount,
    decimals,
  });
  try {
    const sig = await send(from, [ix]);
    console.log(`on-chain: confirmed ${explorer(sig)}`);
  } catch (error) {
    const code = customCode(error);
    const reason = code !== undefined ? getComplianceErrorMessage(code) : String(error);
    console.log(`on-chain: rejected - ${reason}${code !== undefined ? ` (${code})` : ''}`);
  }
}

await transfer('treasury -> alice', issuer, alice!, units(1_000n));
await transfer('alice -> bob', alice!, bob!, units(250n));
await transfer('alice -> mallory', alice!, mallory!, units(1n));
