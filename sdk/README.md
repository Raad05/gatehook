# @gatehook/sdk

TypeScript client for [Gatehook](https://github.com/Raad05/gatehook), an on-chain
compliance engine for real-world-asset tokens on Solana. Gatehook is a Token-2022
transfer hook: every transfer of a Gatehook mint is checked against the issuer's KYC
registry (KYC expiry, investor tier, jurisdiction, freezes, pause, caps, Reg D/S
lockups, velocity limits).

Built on [`@solana/kit`](https://github.com/anza-xyz/kit).

```bash
npm install @gatehook/sdk @solana/kit
```

Program: `HbNmR9zK6d4BMBgzEWixgp6L3QZh4aP66Am13MXsBkaA` (devnet).

## Transfer a Gatehook token

```ts
import { createSolanaRpc } from '@solana/kit';
import { getCompliantTransferInstruction, preflightTransferFromChain } from '@gatehook/sdk';

const rpc = createSolanaRpc('https://api.devnet.solana.com');

// 1. Predict the hook's verdict (same error the chain would return; 2 RPC calls).
const check = await preflightTransferFromChain(rpc, {
  mint,
  sourceOwner: wallet.address,
  destinationOwner: recipient,
  amount: 10_000_000n,
});
if (!check.ok) throw new Error(check.message); // e.g. "Recipient KYC has expired"

// 2. Build transfer_checked with the hook's extra accounts (no RPC lookups).
const ix = await getCompliantTransferInstruction({
  source,                 // sender's token account
  destination,            // recipient's token account
  mint,
  authority: wallet,      // TransactionSigner (owner or delegate)
  destinationOwner: recipient,
  registry,               // ComplianceConfig.registry of the mint
  amount: 10_000_000n,
  decimals: 6,
});
```

Generic integrations can instead use `getTransferCheckedWithTransferHookInstructionAsync`
from `@solana-program/token-2022`; it produces the same accounts.

## Read compliance state

```ts
import { fetchComplianceConfig, fetchMaybeIdentity, findConfigPda, findIdentityPda, jurisdictionCode, Tier } from '@gatehook/sdk';

const [configAddress] = await findConfigPda({ mint });
const config = await fetchComplianceConfig(rpc, configAddress);
const [identityAddress] = await findIdentityPda({ registry: config.data.registry, wallet: owner });
const identity = await fetchMaybeIdentity(rpc, identityAddress);
if (identity.exists) {
  console.log(Tier[identity.data.tier], jurisdictionCode(identity.data.jurisdiction), identity.data.kycExpiry);
}
```

## Decode errors

```ts
import { getComplianceErrorMessage, isGatehookError, GATEHOOK_ERROR__RECIPIENT_KYC_EXPIRED } from '@gatehook/sdk';

getComplianceErrorMessage(6015); // "Recipient KYC has expired"
```

Use `getComplianceErrorMessage` in apps: the generated `getGatehookErrorMessage` returns a
placeholder when `NODE_ENV=production`.

## What's included

| Module | Exports |
|---|---|
| Generated client | every instruction builder (`getInitRegistryInstructionAsync`, `getUpsertIdentityInstructionAsync`, …), account fetchers/decoders, PDA helpers, error codes, `TransferApproved` event codec |
| `transfer` | `getCompliantTransferInstruction`, `getHookExtraAccountMetas` |
| `preflight` | `preflightTransfer` (pure), `preflightTransferFromChain` |
| `rules` | `buildComplianceRules`, `jurisdictionBitmap`, `isJurisdictionAllowed`, `isTierAllowed` |
| `jurisdictions` | `JURISDICTIONS`, `jurisdictionIndex('DE')`, `jurisdictionCode(58)` |

ESM only. Requires Node 20.18+ or a modern bundler.

More: [DEX integration guide](https://github.com/Raad05/gatehook/blob/main/docs/dex-integration.md) ·
[issuer runbook](https://github.com/Raad05/gatehook/blob/main/docs/issuer-runbook.md).
