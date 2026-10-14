# Gatehook

[![CI](https://github.com/Raad05/gatehook/actions/workflows/ci.yml/badge.svg)](https://github.com/Raad05/gatehook/actions/workflows/ci.yml)

On-chain compliance for real-world-asset tokens on Solana. Gatehook is a
[Token-2022 transfer hook](https://spl.solana.com/token-2022/extensions#transfer-hook)
written in Anchor: every `transfer_checked` of a Gatehook mint is checked
against the issuer's KYC registry and the mint's rules before it settles.
DEXs and wallets keep working, because they resolve the hook's accounts the
standard way.

**Rules enforced on every transfer:** KYC validity and expiry, investor tier
(Reg D accredited, Reg S, qualified purchaser, issuer, venue), jurisdiction
allowlist, per-identity freeze, global pause, per-transfer cap, Reg S
US-person restriction, issuance lockup, per-holder holding period, and
per-tier rolling velocity limits. The issuer can claw back tokens via the
mint's permanent delegate.

See [`plan.md`](plan.md) for the architecture, rule order and roadmap.

**Devnet:** program `HbNmR9zK6d4BMBgzEWixgp6L3QZh4aP66Am13MXsBkaA` with a demo token —
see [`docs/deployments.md`](docs/deployments.md).

| Doc | For |
|---|---|
| [Issuer runbook](docs/issuer-runbook.md) | creating tokens, operating the oracle, incidents, mainnet checklist |
| [DEX integration](docs/dex-integration.md) | building hooked transfers, venue identities, error codes |
| [Security review](docs/security-review.md) | findings, fixes, residual risks |

## How it works

| Account | One per | Holds |
|---|---|---|
| `Registry` | issuer | admin (multisig) and oracle keys |
| `ComplianceConfig` | mint | pause flag and `ComplianceRules` |
| `Identity` | wallet per registry | tier, jurisdiction, KYC expiry, holding period, freeze flag, velocity counters |

The off-chain KYC oracle writes `Identity` accounts; the admin manages rules,
pauses and freezes. Token-2022 calls the hook's `execute` on each transfer,
passing the config, registry and both parties' identities.

## Repository

```
programs/gatehook/   Anchor program + LiteSVM tests
sdk/                 @gatehook/sdk: generated client, rules builder, transfer builder, preflight
scripts/             issuer CLI: create-mint, seed, demo-transfer
oracle/              KYC oracle: provider webhooks -> wallet linking -> on-chain identities
portal/              demo investor portal: sign in, KYC, link wallet, hold & transfer
docs/                deployments, security review, issuer runbook, DEX integration
```

## Prerequisites

Rust 1.89 (via `rust-toolchain.toml`), Solana CLI 3.1, Anchor CLI 1.2, Node 22+, pnpm 11,
Docker (optional, for the oracle's Postgres).

## Build and test

```bash
anchor run build      # anchor build --arch v1 (SBPF v3 is not live on devnet/mainnet)
anchor run test       # build + Rust tests
pnpm install
pnpm generate         # regenerate the SDK client after IDL changes
pnpm typecheck
pnpm test             # SDK + oracle tests
```

## Local demo

```bash
solana-test-validator --reset \
  --bpf-program HbNmR9zK6d4BMBgzEWixgp6L3QZh4aP66Am13MXsBkaA target/deploy/gatehook.so

cd scripts
CLUSTER=localnet pnpm create-mint --name "T-Bill 2027" --symbol TB27
CLUSTER=localnet pnpm seed            # treasury, alice (US), bob (DE, Reg S), mallory (no KYC)
CLUSTER=localnet pnpm demo-transfer   # two transfers pass, the one to mallory is rejected
```

Onboard a single wallet without the oracle (issuer/oracle key signs):

```bash
CLUSTER=devnet pnpm attest --wallet <address> --tier non_us --country DE --send 10   # attest + send 10 tokens
CLUSTER=devnet pnpm attest --wallet <address> --expire                               # expire its KYC
```

Environment: `CLUSTER` (`localnet` | `devnet`), `RPC_URL`, `WS_URL`,
`ISSUER_KEYPAIR` (default `~/.config/solana/id.json`), `ORACLE_KEYPAIR`
(defaults to the issuer).

## KYC oracle

The oracle turns KYC provider decisions into on-chain `Identity` accounts.

1. The provider calls `POST /webhooks/kyc` (signed; replayed and out-of-order events are ignored).
2. The issuer's investor portal links a wallet: `POST /wallets/:wallet/challenge`, the
   investor signs the returned message, then `POST /wallets/:wallet/link`.
3. A worker reconciles each linked wallet: approved → `upsert_identity`; rejected or
   revoked → attestation expired (`kyc_expiry = 0`); unchanged → nothing sent.

```bash
cd oracle
docker compose up -d                 # Postgres on 127.0.0.1:5434 (ORACLE_PG_PORT to change)
cp .env.example .env                 # set REGISTRY, API_KEY, MOCK_WEBHOOK_SECRET, ORACLE_KEYPAIR
pnpm start
pnpm dev:cli webhook inv-001 approved --tier non_us --country DE
pnpm dev:cli link inv-001 ~/investor-keypair.json
```

`ORACLE_KEYPAIR` must be the registry's oracle key (`ORACLE_KEYPAIR` in `create-mint`).
Admin endpoints (`GET /applicants/:id`, `GET /jobs`, `POST /jobs/:id/retry`) need
`Authorization: Bearer $API_KEY`. Use `DATABASE_URL=pglite://.pglite` to run without Docker.

## Investor portal

A reference web app for investors: sign in, verify identity, link a wallet (browser
extension or test burner wallet), then hold and transfer with live compliance checks.
See [`portal/README.md`](portal/README.md).

## SDK

`@gatehook/sdk` is ready to publish (ESM, typed, `@solana/kit` peer); see [`sdk/README.md`](sdk/README.md).
Until it's on npm, build a tarball with `cd sdk && pnpm pack` and install that.

### Example

```ts
import { getCompliantTransferInstruction, preflightTransferFromChain } from '@gatehook/sdk';

const check = await preflightTransferFromChain(rpc, { mint, sourceOwner, destinationOwner, amount });
if (!check.ok) throw new Error(check.message); // e.g. "Recipient KYC has expired"

const ix = await getCompliantTransferInstruction({
  source, destination, mint, authority, destinationOwner, registry, amount, decimals,
});
```

Generic integrators can use `getTransferCheckedWithTransferHookInstructionAsync`
from `@solana-program/token-2022` instead; it produces the same accounts.
