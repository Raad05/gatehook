# DEX and wallet integration

Gatehook mints are standard Token-2022 mints with a transfer hook. Any integration that
supports transfer hooks works; this page lists what it must do and what to expect.

## Building transfers

Use `transfer_checked` (plain `transfer` is rejected for hooked mints) and append the
hook's extra accounts. Either:

- **Generic (recommended for multi-token integrations):** resolve from the mint's
  `ExtraAccountMetaList`, e.g. `getTransferCheckedWithTransferHookInstructionAsync` from
  `@solana-program/token-2022`, or `createTransferCheckedWithTransferHookInstruction`
  from `@solana/spl-token`. On-chain programs doing CPIs: `spl_token_2022::onchain::invoke_transfer_checked`.
- **Gatehook SDK (no RPC lookups):** `getCompliantTransferInstruction` from `@gatehook/sdk`.

Both produce the same accounts (tested). Appended after the four `transfer_checked` accounts:

| # | Account | Writable | Derivation |
|---|---|---|---|
| 5 | `ComplianceConfig` | no | PDA `["config", mint]` |
| 6 | `Registry` | no | fixed per mint (stored in the meta list) |
| 7 | Sender `Identity` | **yes** | PDA `["identity", registry, source.owner]` |
| 8 | Recipient `Identity` | no | PDA `["identity", registry, destination.owner]` |
| + | Gatehook program | no | `HbNmR9zK6d4BMBgzEWixgp6L3QZh4aP66Am13MXsBkaA` |
| + | `ExtraAccountMetaList` | no | PDA `["extra-account-metas", mint]` |

Identities are derived from token-account **owners**, so a router acting as delegate does
not need its own identity — but **pool and escrow owner PDAs do**: issuers must attest
them with the `Venue` tier, or transfers into/out of the pool fail with
`RecipientIdentityNotFound` / `SenderIdentityNotFound`.

The sender identity is writable (velocity counters). Account for it in write-lock
planning, and for six extra accounts per hooked transfer (use address lookup tables for
multi-hop routes).

## Compute

A hooked `transfer_checked` costs ~29k CU in total (Token-2022 + hook). Budget ~35k per
Gatehook leg.

## Pre-trade checks

To avoid failed transactions, check before quoting:

```ts
import { preflightTransferFromChain } from '@gatehook/sdk';

const result = await preflightTransferFromChain(rpc, { mint, sourceOwner, destinationOwner, amount });
if (!result.ok) showError(result.message); // same error the hook would return
```

It mirrors the hook's checks in order using two RPC requests. The chain stays authoritative.

## Errors

The hook fails with custom program errors (Anchor offset 6000). Decode with
`getGatehookErrorMessage(code)` / `isGatehookError` from `@gatehook/sdk`.

| Code | Name | Meaning |
|---|---|---|
| 6006 | NotTransferring | Hook called outside a Token-2022 transfer |
| 6007 | MintMismatch | Wrong config for this mint |
| 6008 | Paused | Issuer paused transfers |
| 6009 | AmountExceedsMax | Above per-transfer cap |
| 6010 / 6011 | Sender / RecipientIdentityNotFound | Wallet not KYC'd with this issuer |
| 6012 / 6013 | Sender / RecipientFrozen | Wallet frozen by issuer |
| 6014 / 6015 | Sender / RecipientKycExpired | KYC lapsed |
| 6016 / 6017 | Sender / RecipientTierNotAllowed | Investor class not allowed for this token |
| 6018 / 6019 | Sender / RecipientJurisdictionNotAllowed | Country not allowed |
| 6020 | RegSRestricted | Reg S holder → US person during compliance period |
| 6021 | GlobalLockup | Token still in issuance lockup |
| 6022 | HolderLockup | Sender in holding period |
| 6023 | VelocityLimitExceeded | Sender over rolling volume limit |

Full list: `sdk/src/generated/errors/gatehook.ts`.
