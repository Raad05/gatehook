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
