# Project Plan: Institutional RWA Compliance Engine (Token-2022 Transfer Hook)

## 1. Executive Summary
**Objective:** Build a deterministic, on-chain compliance module for Real-World Assets (RWAs) on Solana using the **Token-2022 Transfer Hook Extension** and **Anchor**. 

**Problem Solved:** Regulated asset issuers (treasury bills, private credit, tokenized equities) require strict secondary market trading rules (KYC/AML verification, SEC Reg D/S lockups, investor accreditation checks, and transaction velocity caps) without breaking DeFi composability or relying on reactive off-chain wallet freezing.

---

## 2. System Architecture

```text
+-------------------------------------------------------------------------+
|                        CLIENT / DEX / DAPP                              |
|  Resolves ExtraAccountMetaList via @solana/spl-token & submits tx       |
+------------------------------------+------------------------------------+
                                     |
                                     | 1. spl_token_2022::transfer_checked
                                     v
+-------------------------------------------------------------------------+
|                      SPL TOKEN-2022 CORE PROGRAM                        |
|  Executes base balance checks & detects TransferHook extension on Mint  |
+------------------------------------+------------------------------------+
                                     |
                                     | 2. Automatic CPI (TransferHookInterface)
                                     v
+-------------------------------------------------------------------------+
|                   RWA COMPLIANCE HOOK PROGRAM (Anchor)                  |
|                                                                         |
|  +-----------------------+  +-------------------+  +-----------------+  |
|  | ComplianceConfig PDA  |  | Sender Identity   |  | Recipient ID    |  |
|  | - Global Pause        |  | PDA               |  | PDA             |  |
|  | - Max Tx Cap          |  | - KYC Expiry      |  | - KYC Expiry    |  |
|  | - Lockup Timestamp    |  | - Tier (Reg D/S)  |  | - Tier          |  |
|  | - Allowed Jurisdict.  |  | - Frozen Flag     |  | - Frozen Flag   |  |
|  +-----------------------+  +-------------------+  +-----------------+  |
+-------------------------------------------------------------------------+
                                     ^
                                     | 3. Attestations / KYC Updates
+------------------------------------+------------------------------------+
|                  OFF-CHAIN KYC ORACLE / ADMIN SERVICE                   |
|  Verifies off-chain KYC credentials & updates Identity PDAs on-chain    |
+-------------------------------------------------------------------------+

---

## 3. Implementation Plan & Status

**v1 scope:** hook program + TS SDK + minimal KYC oracle service + devnet deploy. Admin UI deferred.
**Identity scope:** per issuer registry — one KYC record per wallet per issuer, reused across the issuer's mints.

| # | Milestone | Status |
|---|---|---|
| 1 | Foundation: `Registry` / `ComplianceConfig` / `Identity` accounts, admin + identity instructions | ✅ Done |
| 2 | Hook core: `init_extra_account_metas` + `execute` with all rules, real `transfer_checked` tests | ✅ Done |
| 3 | Rule test matrix: one test per rejection + boundaries, CU budget (27.6k CU per hooked transfer) | ✅ Done |
| 4 | TS SDK (Codama + helpers) and issuer scripts (`create-mint`, `seed`, `demo-transfer`) | ✅ Done |
| 5 | KYC oracle service (Fastify, Postgres, provider webhook, tx worker) | ⏳ Next |
| 6 | Devnet deploy, CI, security review, issuer runbook + DEX integration guide | Planned |

### Tech stack

| Layer | Choice |
|---|---|
| Program | Rust 1.89, Anchor 1.2, `anchor-spl`, `spl-transfer-hook-interface` 2.1, `spl-tlv-account-resolution` 0.11; built as **SBPF v1** |
| Program tests | LiteSVM (Rust) with the bundled Token-2022 program |
| SDK | TypeScript 7, `@solana/kit` 8.4, `@solana-program/token-2022` 0.19, Codama-generated client |
| SDK tests | vitest + litesvm (Node) against the built program |
| Oracle (M5) | Node 22+, Fastify, Postgres (Drizzle), pluggable KYC provider (Sumsub/Persona), mock provider for dev |
| Keys (prod) | Registry admin = Squads multisig; oracle signer in KMS |

### Hook rules (`execute`, evaluated in order)

1. Source account's Token-2022 `transferring` flag is set (blocks direct calls).
2. Config belongs to the mint; registry matches the config.
3. Admin acting as delegate over someone else's tokens (permanent-delegate clawback) → allowed, logged as `forced`.
4. Sender and recipient identities exist in the mint's registry (looked up by token-account **owner**).
5. Mint not paused; amount ≤ per-transfer cap.
6. For each side: not frozen, KYC not expired, tier allowed, jurisdiction allowed.
7. Reg S sender → no US recipient until `reg_s_compliance_until`.
8. Global lockup and sender's holding period have passed (Issuer tier exempt).
9. Sender's rolling velocity window stays within the per-tier limit (counters written back).

### Key decisions

- Mint config creation requires the mint's hook program = gatehook and hook authority = registry admin (no configs on someone else's mint).
- Only the oracle writes identities; oracle refreshes never clear an admin freeze or velocity counters.
- No tier is exempt from KYC expiry; venues/issuer get far-future expiry instead (rules stay data-driven).
- Identities are passed to the hook unchecked and validated by owner + discriminator + field match (cheaper than PDA derivation, clearer errors).
- Errors and jurisdiction indices are append-only (client API / on-chain data).

### Open risks

- AMM pools and escrow PDAs need `Venue` identities or trades through them fail — define a venue whitelisting process.
- DEXs must forward the hook's extra accounts (standard via `@solana-program/token-2022` / `@solana/spl-token` resolvers).
- Reg D/S rule specifics to be confirmed with counsel; rules are config data, not code.
- Upgrade authority and registry admin must move to a multisig before mainnet.
