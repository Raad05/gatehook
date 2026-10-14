// Wallet layer: Wallet Standard extensions (Phantom, Solflare, Backpack...) and
// a devnet-only burner wallet, behind one `ActiveWallet` interface.
import {
  type Address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  signBytes,
  signTransactionMessageWithSigners,
  type SolanaRpcApi,
  type TransactionSigner,
} from '@solana/kit';
import { useSignMessage, useWalletAccountTransactionSendingSigner } from '@solana/react';
import { type UiWallet, type UiWalletAccount, useConnect, useWallets } from '@wallet-standard/react';
import { useEffect } from 'react';

export type ActiveWallet = {
  kind: 'burner' | 'extension';
  label: string;
  address: Address;
  signer: TransactionSigner;
  /** ed25519 signature over the exact message bytes. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Signs, sends and waits for confirmation; returns the signature. */
  send(rpc: Rpc<SolanaRpcApi>, instructions: Instruction[]): Promise<string>;
};

async function confirm(rpc: Rpc<SolanaRpcApi>, signature: string) {
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([signature as never]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('Timed out waiting for confirmation');
}

async function buildMessage(rpc: Rpc<SolanaRpcApi>, feePayer: TransactionSigner, instructions: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

// ---- burner (devnet only) ----

const BURNER_KEY = 'gatehook.portal.burner';

function burnerWallet(signer: KeyPairSigner): ActiveWallet {
  return {
    kind: 'burner',
    label: 'Devnet burner',
    address: signer.address,
    signer,
    signMessage: (message) => signBytes(signer.keyPair.privateKey, message),
    async send(rpc, instructions) {
      const tx = await signTransactionMessageWithSigners(await buildMessage(rpc, signer, instructions));
      const signature = getSignatureFromTransaction(tx);
      await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
      await confirm(rpc, signature);
      return signature;
    },
  };
}

/** Loads (or creates) a burner key kept in this browser's localStorage. Throwaway, devnet only. */
export async function loadBurner(): Promise<ActiveWallet> {
  let hex = localStorage.getItem(BURNER_KEY);
  if (!hex) {
    hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(BURNER_KEY, hex);
  }
  const seed = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  return burnerWallet(await createKeyPairSignerFromPrivateKeyBytes(seed));
}

// ---- Wallet Standard extensions ----

const CHAIN = { devnet: 'solana:devnet', localnet: 'solana:localnet' } as const;

/** Installed wallets that can sign messages and send transactions on `cluster`. */
export function useCompatibleWallets(cluster: keyof typeof CHAIN): readonly UiWallet[] {
  return useWallets().filter(
    (w) =>
      w.chains.includes(CHAIN[cluster]) &&
      w.features.includes('solana:signMessage') &&
      w.features.includes('solana:signAndSendTransaction'),
  );
}

export function ConnectButton({ wallet, onAccount }: { wallet: UiWallet; onAccount: (a: UiWalletAccount) => void }) {
  const [connecting, connect] = useConnect(wallet);
  return (
    <button
      className="secondary"
      disabled={connecting}
      onClick={async () => {
        const accounts = await connect();
        if (accounts[0]) onAccount(accounts[0]);
      }}
    >
      {wallet.icon && <img src={wallet.icon} alt="" width={18} height={18} />} {connecting ? 'Connecting…' : wallet.name}
    </button>
  );
}

/** Adapts a connected Wallet Standard account into an `ActiveWallet` (hooks need a component). */
export function ExtensionWalletBridge({
  account,
  cluster,
  name,
  onReady,
}: {
  account: UiWalletAccount;
  cluster: keyof typeof CHAIN;
  name: string;
  onReady: (wallet: ActiveWallet) => void;
}) {
  const signMessage = useSignMessage(account);
  const signer = useWalletAccountTransactionSendingSigner(account, CHAIN[cluster]);
  useEffect(() => {
    onReady({
      kind: 'extension',
      label: name,
      address: account.address as Address,
      signer,
      signMessage: async (message) => (await signMessage({ message })).signature,
      async send(rpc, instructions) {
        const signatureBytes = await signAndSendTransactionMessageWithSigners(await buildMessage(rpc, signer, instructions));
        const signature = getBase58Decoder().decode(signatureBytes);
        await confirm(rpc, signature);
        return signature;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.address]);
  return null;
}
