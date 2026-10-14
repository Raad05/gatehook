// LiteSVM harness: loads the built program and exposes kit-style helpers.
import { fileURLToPath } from 'node:url';
import {
  type Address,
  appendTransactionMessageInstructions,
  type Base64EncodedBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Decoder,
  type GetAccountInfoApi,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getInitializePermanentDelegateInstruction,
  getInitializeTransferHookInstruction,
  getMintSize,
  getMintToInstruction,
  getTokenSize,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { GATEHOOK_PROGRAM_ADDRESS } from '../src/index.ts';

export const DECIMALS = 6;
const SO_PATH = fileURLToPath(new URL('../../target/deploy/gatehook.so', import.meta.url));

export type SendResult = { ok: true; cu: bigint } | { ok: false; code: number | null; logs: string[] };

export class Svm {
  readonly svm = new LiteSVM();

  constructor() {
    this.svm.addProgramFromFile(GATEHOOK_PROGRAM_ADDRESS, SO_PATH);
  }

  async fundedSigner(): Promise<KeyPairSigner> {
    const signer = await generateKeyPairSigner();
    this.svm.airdrop(signer.address, lamports(10_000_000_000n));
    return signer;
  }

  async send(payer: KeyPairSigner, instructions: Instruction[]): Promise<SendResult> {
    this.svm.expireBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const result = this.svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      // Structural match: litesvm doesn't export the error classes.
      const err: unknown = result.err();
      const inner: unknown =
        typeof err === 'object' && err !== null && 'index' in err && 'err' in err && typeof err.err === 'function'
          ? err.err()
          : null;
      const code = typeof inner === 'object' && inner !== null && 'code' in inner ? (inner.code as number) : null;
      return { ok: false, code, logs: result.meta().logs() };
    }
    return { ok: true, cu: result.computeUnitsConsumed() };
  }

  async sendOk(payer: KeyPairSigner, instructions: Instruction[]): Promise<bigint> {
    const result = await this.send(payer, instructions);
    if (!result.ok) throw new Error(`tx failed (code ${result.code}):\n${result.logs.join('\n')}`);
    return result.cu;
  }

  setTime(unixTimestamp: bigint) {
    const clock = this.svm.getClock();
    clock.unixTimestamp = unixTimestamp;
    this.svm.setClock(clock);
  }

  /** Minimal `getAccountInfo` RPC backed by LiteSVM, for kit fetchers/resolvers. */
  rpc(): Rpc<GetAccountInfoApi> {
    const svm = this.svm;
    const decoder = getBase64Decoder();
    return {
      getAccountInfo(address: Address) {
        return {
          send: async () => {
            const account = svm.getAccount(address);
            return {
              context: { slot: 0n },
              value: account.exists
                ? {
                    data: [decoder.decode(account.data) as Base64EncodedBytes, 'base64'],
                    executable: account.executable,
                    lamports: account.lamports,
                    owner: account.programAddress,
                    space: BigInt(account.data.length),
                    rentEpoch: 0n,
                  }
                : null,
            };
          },
        };
      },
    } as unknown as Rpc<GetAccountInfoApi>;
  }

  async createMint(payer: KeyPairSigner, hookAuthority: Address, permanentDelegate?: Address): Promise<Address> {
    const mint = await generateKeyPairSigner();
    const extensions = [
      { __kind: 'TransferHook' as const, authority: hookAuthority, programId: GATEHOOK_PROGRAM_ADDRESS },
      ...(permanentDelegate ? [{ __kind: 'PermanentDelegate' as const, delegate: permanentDelegate }] : []),
    ];
    const space = getMintSize(extensions);
    await this.sendOk(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: this.svm.minimumBalanceForRentExemption(BigInt(space)),
        space,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getInitializeTransferHookInstruction({ mint: mint.address, authority: hookAuthority, programId: GATEHOOK_PROGRAM_ADDRESS }),
      ...(permanentDelegate ? [getInitializePermanentDelegateInstruction({ mint: mint.address, delegate: permanentDelegate })] : []),
      getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: payer.address }),
    ]);
    return mint.address;
  }

  async createTokenAccount(payer: KeyPairSigner, mint: Address, owner: Address): Promise<Address> {
    const account = await generateKeyPairSigner();
    const space = getTokenSize([{ __kind: 'TransferHookAccount', transferring: false }]);
    await this.sendOk(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: account,
        lamports: this.svm.minimumBalanceForRentExemption(BigInt(space)),
        space,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getInitializeAccount3Instruction({ account: account.address, mint, owner }),
    ]);
    return account.address;
  }

  async mintTo(mintAuthority: KeyPairSigner, mint: Address, token: Address, amount: bigint) {
    await this.sendOk(mintAuthority, [getMintToInstruction({ mint, token, mintAuthority, amount })]);
  }
}
