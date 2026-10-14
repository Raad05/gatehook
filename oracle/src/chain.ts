import {
  fetchMaybeIdentity,
  findIdentityPda,
  getUpsertIdentityInstructionAsync,
  type Identity,
} from '@gatehook/sdk';
import {
  type Address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import type { IdentityParams } from './domain/reconcile.ts';

/** On-chain side of the oracle; swapped for LiteSVM in tests. */
export interface Chain {
  readonly registry: Address;
  getIdentity(wallet: Address): Promise<Identity | null>;
  /** Sends `upsert_identity` signed and paid by the oracle; returns the signature. */
  upsertIdentity(wallet: Address, params: IdentityParams): Promise<string>;
}

export function upsertIdentityInstruction(oracle: KeyPairSigner, registry: Address, wallet: Address, params: IdentityParams) {
  return getUpsertIdentityInstructionAsync({ oracle, payer: oracle, registry, wallet, ...params });
}

export class RpcChain implements Chain {
  private readonly rpc;
  private readonly sendAndConfirm;

  constructor(
    private readonly oracle: KeyPairSigner,
    readonly registry: Address,
    urls: { http: string; ws: string },
  ) {
    this.rpc = createSolanaRpc(urls.http);
    this.sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc: this.rpc,
      rpcSubscriptions: createSolanaRpcSubscriptions(urls.ws),
    });
  }

  async getIdentity(wallet: Address): Promise<Identity | null> {
    const [pda] = await findIdentityPda({ registry: this.registry, wallet });
    const account = await fetchMaybeIdentity(this.rpc, pda, { commitment: 'confirmed' });
    return account.exists ? account.data : null;
  }

  async upsertIdentity(wallet: Address, params: IdentityParams): Promise<string> {
    return this.send([await upsertIdentityInstruction(this.oracle, this.registry, wallet, params)]);
  }

  private async send(instructions: Instruction[]): Promise<string> {
    const { value: blockhash } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.oracle, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(tx);
    await this.sendAndConfirm(tx, { commitment: 'confirmed' });
    return getSignatureFromTransaction(tx);
  }
}
