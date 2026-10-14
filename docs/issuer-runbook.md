# Issuer runbook

Operating a Gatehook-compliant token: setup, day-to-day operations and incidents.
Commands assume the repo root, `pnpm install`, and a built program (`anchor run build`).

## Roles and keys

| Role | Powers | Production custody |
|---|---|---|
| Issuer / registry admin | rules, pause, freeze, clawback (as permanent delegate), oracle rotation, admin rotation | Squads multisig |
| Mint authority | issue new supply (no hook runs on mint) | Squads multisig |
| Transfer-hook authority | repoint the mint's hook | Same multisig as admin (required by `init_mint_config`) |
| Oracle | create/refresh/expire identities; pays identity rent | KMS-held hot key, funded and monitored |
| Program upgrade authority | replace program code | Multisig / governance |

## 1. Create a token

```bash
cd scripts
CLUSTER=devnet ISSUER_KEYPAIR=~/issuer.json ORACLE_KEYPAIR=~/oracle.json \
  pnpm create-mint --name "T-Bill 2027" --symbol TB27 --uri https://example.com/tb27.json
```

This creates the registry (once per issuer), a Token-2022 mint with **TransferHook →
Gatehook**, **PermanentDelegate = issuer** (clawback) and on-chain metadata, then the
mint's `ComplianceConfig` and `ExtraAccountMetaList`. Edit the rules in
`scripts/src/create-mint.ts` (`buildComplianceRules`) before running.

**Do not add** Confidential Transfer, Non-Transferable or other extensions without a
review: they were not assessed with the hook.

## 2. Run the KYC oracle

See the README's "KYC oracle" section. In production: Postgres, a real provider adapter
(the mock is for development only), `ORACLE_KEYPAIR` = the registry's oracle key, and
the service reachable only from the provider (webhook) and your investor portal.

Investor onboarding:
1. Investor completes KYC with the provider → webhook updates the applicant.
2. Your portal (authenticated session) calls `/wallets/:wallet/challenge`, the investor
   signs the message in their wallet, the portal calls `/wallets/:wallet/link`.
3. The worker writes the identity on-chain. Check with `GET /jobs?wallet=<address>`.

`portal/` is a reference implementation of this flow (demo sign-in and KYC). For one-off
wallets (venues, testing) skip the oracle: `pnpm attest --wallet <address> --tier venue --days 3650`.

## 3. Issue supply

Mint only to token accounts whose owner has a valid identity — normally the treasury
(Issuer tier). Distribute from the treasury with normal transfers so every movement
passes the hook.

## 4. Day-to-day

| Task | How |
|---|---|
| Change rules (caps, jurisdictions, tiers, lockups, velocity) | `update_config` (admin). Applies to the next transfer. |
| Whitelist an AMM pool / escrow | Attest the pool's **owner PDA** with tier `Venue`, far-future expiry: `pnpm attest --wallet <pool owner> --tier venue --days 3650`. Trades through un-attested pools fail. |
| KYC expiring soon | Oracle logs/audits `kyc_expiring` (`EXPIRY_WARNING_DAYS`). Enforcement is automatic at expiry. |
| Failed oracle jobs | `GET /jobs?status=failed`, fix the cause (RPC, oracle SOL balance), `POST /jobs/:id/retry`. |
| Fund the oracle | Each new identity costs rent (~0.002 SOL). Alert on low balance. |

## 5. Incidents

| Situation | Action |
|---|---|
| Market-wide halt | `set_pause(true)`. Clawbacks still work. `set_pause(false)` to resume. |
| One wallet (sanctions, fraud, court order) | `set_identity_frozen(true)` (admin or oracle). Freezes survive oracle refreshes and KYC revoke/re-approve. |
| Recover tokens | Transfer as permanent delegate (admin signs as authority) from the holder's account to a **verified** recipient (treasury or the rightful owner's attested wallet). Logged as `TransferApproved { forced: true }`. |
| Oracle key compromised | `set_oracle(<new key>)` (admin). Review `audit_log` and on-chain `upsert_identity` txs since the compromise; freeze or expire affected identities. |
| Admin key rotation | `propose_admin(<new>)` from the current admin, then `accept_admin` signed by the new key. Also move the mint's transfer-hook authority and permanent delegate to the new key with Token-2022 `SetAuthority`. |

## Mainnet checklist

- [ ] Independent audit of program and oracle; findings resolved.
- [ ] Upgrade authority, registry admin, mint authority, hook authority and permanent delegate on a multisig.
- [ ] Real KYC provider adapter; mock provider disabled.
- [ ] Oracle key in KMS; balance and `audit_log` monitoring; alerting on failed jobs.
- [ ] Rules reviewed by counsel (Reg D/S periods, jurisdictions, tiers).
- [ ] Venue identities for every pool/escrow the token will trade through.
- [ ] Program built with `--arch v1` (re-check SBPF v3 activation at the time), binary hash recorded in `docs/deployments.md`.
