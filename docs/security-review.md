# Security review

Internal review of the program and the oracle, done at milestone 6 (2026-10-14) before the
devnet deploy. It is not a substitute for an independent audit, which is required before
mainnet.

**Scope:** `programs/gatehook` (all instructions, the hook, account validation),
`oracle/` (HTTP API, webhook auth, wallet linking, job worker), and the SDK preflight
where it mirrors on-chain logic.

**Method:** line-by-line read of every instruction and route; threat modelling per
actor (holder, delegate/router, outsider, oracle key, admin key, KYC provider, API
client); a test for each finding and each verified property.

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| P1 | Medium | Registry admin could not be rotated, so the planned move to a multisig (or recovery from a leaked key) was impossible. | **Fixed:** two-step `propose_admin` / `accept_admin`; proposal cancellable; registry PDA stays keyed by the original issuer. |
| P2 | Medium | Admin-as-delegate ("forced") transfers skipped every rule, so the admin key could move tokens to wallets with no KYC or a freeze. | **Fixed:** forced transfers skip sender rules, pause, caps and lockups, but the recipient must exist and pass freeze/KYC/tier/jurisdiction checks. Mirrored in SDK preflight. |
| P3 | Info | The forced path applies to any delegate approval to the admin, not only the permanent delegate. | Accepted: equivalent power; the admin must be a multisig. |
| P4 | Low | No instruction updates a mint's `ExtraAccountMetaList`. | Accepted: account layout is fixed; add an admin-only update if the hook accounts ever change. |
| P5 | Info | Token-2022 does not call hooks on `mint_to` / `burn`, so the mint authority can issue to any wallet. | Process control: mint authority = multisig; issue only to the KYC'd treasury (runbook). |
| P6 | Info | The mint's transfer-hook authority can repoint the hook to another program. | Process control: hook authority = registry admin multisig. |
| P7 | Info | Hook behaviour with Confidential Transfer / other amount-hiding extensions was not reviewed. | Do not enable them on Gatehook mints (runbook). |
| O1 | Medium | Invalid path/query parameters raised unhandled validation errors (HTTP 500). | **Fixed:** mapped to 400; tested. |
| O2 | Low | Expired wallet-link challenges were never deleted (unbounded growth by API clients). | **Fixed:** sweeper prunes challenges a day after expiry. |
| O3 | Info | `GET /jobs` ignored `wallet` when `status` was also given. | **Fixed:** filters combine. |
| O4 | Medium | (M5 design) Closing identities on KYC revocation would drop an admin freeze, which re-approval would silently undo. | **Fixed in M5:** the oracle expires attestations (`kyc_expiry = 0`) and never closes them; tested. |
| O5 | Info | Only the mock KYC provider exists; it must never face the internet in production. | Open: implement a real provider adapter before production. |
| O6 | Info | No rate limiting on the API. | Accepted: internal service; put it behind the issuer's gateway. |
| C1 | Low | `preflightTransferFromChain` made 5 parallel RPC calls and hit public-RPC rate limits (seen on devnet). | **Fixed:** 2 requests (`getMultipleAccounts`). |

## Verified properties (each covered by tests)

- `execute` rejects direct calls: Token-2022's `transferring` flag must be set on the source.
- Identities are bound to the mint's registry and to the token-account **owners**; a
  delegate/router cannot substitute its own identity; planted identities from another
  registry or for another wallet are rejected.
- Config and registry accounts cannot be swapped (`MintMismatch`, `RegistryMismatch`).
- Configs can only be attached to mints whose hook points at Gatehook with the registry
  admin as hook authority.
- Only the oracle writes identities; oracle refreshes never clear a freeze or velocity counters.
- Velocity accounting uses checked arithmetic; per-tier limits; window resets are tested at boundaries.
- Hooked transfer stays at ~29k CU (budget assertion at 60k).
- Webhooks: HMAC over timestamp + body, 5-minute tolerance, event-id dedupe, stale-event ordering.
- Wallet links: ed25519 signature over a server-issued, single-use (atomic conditional
  update), 10-minute challenge; one applicant per wallet.
- API key compared in constant time; all SQL is parameterised (Drizzle); every state change is audit-logged.

## Residual risks

- **Admin key:** can pause, change rules, freeze and claw back. Must be a multisig with a documented signer policy.
- **Oracle key:** can attest any wallet into its registry. Keep it in a KMS, monitor
  `audit_log` / `identity_upsert` events, and rotate with `set_oracle` on suspicion.
- **Upgrade authority:** controls program code. Move to a multisig (or a timelocked governance program) before mainnet.
- **Legal rules:** Reg D/S logic is a technical model; confirm with counsel.
- **No external audit yet.**
