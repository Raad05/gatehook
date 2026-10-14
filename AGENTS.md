## Context Engine (CCE)

This project uses Code Context Engine for intelligent code retrieval and
cross-session memory.

### Searching the codebase

**Use `context_search` instead of reading files directly** when exploring
the codebase, answering questions about code, or understanding how things
work. `context_search` returns the most relevant code chunks with
confidence scores instead of whole files.

When to use `context_search`:
- Answering questions about the codebase ("how does X work?", "where is Y?")
- Exploring structure or architecture
- Finding related code, functions, or patterns

Other tools:
- `expand_chunk` for full source of a compressed result
- `related_context` for what calls/imports a function
- `session_recall` to recall past decisions

### Cross-session memory

Call `session_recall("topic phrase")` before answering non-trivial questions.
Call `record_decision(decision="...", reason="...")` after making choices.
Call `record_code_area(file_path="...", description="...")` after meaningful work.

### Output style

Respond in compressed style. Drop articles (a, an, the) in prose. Use
sentence fragments over full sentences. Use short synonyms (fix not resolve,
check not investigate). Pattern: [thing] [action] [reason]. [next step].
No filler, hedging, pleasantries, trailing summaries, or restating what
the user said. One sentence if one sentence is enough.

When suggesting code changes, show only the changed lines with 3 lines of
context. Never rewrite entire files. Multiple changes in one file: show each
change separately. Never echo back unchanged code the user already has.

Code blocks, file paths, commands, error messages: always written in full.
Security warnings and destructive action confirmations: use full clarity.

## Project: Gatehook

On-chain compliance engine for RWA tokens: a Token-2022 **transfer hook**
(Anchor) that every `transfer_checked` CPIs into. Enforces KYC expiry, investor
tier, jurisdiction allowlist, freezes, pause, per-tx cap, Reg D/S lockups and
velocity limits. Product spec + milestone status: `plan.md`. Usage: `README.md`.

### Layout

- `programs/gatehook/` — Anchor program
  - `src/state/` — `Registry` (per issuer), `ComplianceConfig` + `ComplianceRules` (per mint), `Identity` (per wallet per registry)
  - `src/instructions/admin/` — registry, oracle, mint config, pause
  - `src/instructions/identity/` — oracle upsert, freeze, revoke
  - `src/instructions/hook/` — `init_extra_account_metas`, `execute` (the hook)
  - `tests/` — LiteSVM: `common/` harness (`Ctx`, `HookFixture`), `test_admin`, `test_identity`, `test_transfer`, `test_rules`
- `sdk/` — `@gatehook/sdk` (TS, `@solana/kit`)
  - `src/generated/` — Codama output; **never edit by hand**
  - `src/{jurisdictions,rules,transfer,preflight}.ts` — hand-written helpers
  - `test/` — vitest + litesvm (Node) against the built `.so`
- `portal/` — `@gatehook/portal` demo investor portal: `server/` (Fastify; holds the oracle API key; demo session/KYC/faucet) + `client/` (React 19 + Vite, Wallet Standard + burner wallet, SDK preflight/transfer); `test/` runs against an in-process oracle
- `docs/` — `deployments.md` (devnet addresses), `security-review.md`, `issuer-runbook.md`, `dex-integration.md`
- `.github/workflows/ci.yml` — fmt, build (v1), clippy `-D warnings`, cargo test; then generated-SDK drift check, typecheck, TS tests
- `scripts/` — issuer CLI: `create-mint`, `seed`, `demo-transfer`, `attest` (one wallet, no oracle) (state in gitignored `scripts/.state/`)
- `oracle/` — `@gatehook/oracle` KYC oracle (Fastify + Drizzle/Postgres)
  - `src/app.ts` routes, `src/worker.ts` job runner, `src/chain.ts` (`Chain` interface, `RpcChain`)
  - `src/domain/` — `decisions` (webhook → applicant), `link` (wallet proof), `reconcile` (desired vs on-chain), `jobs` (queue), `sweeper`
  - `src/providers/` — `KycProvider` interface + `MockKycProvider`; `src/dev/cli.ts` sends signed mock webhooks / links wallets
  - `drizzle/` — SQL migrations (generated; applied on startup)
  - `test/` — unit + integration (PGlite + LiteSVM, `test/harness.ts`)

### Commands

```bash
anchor run build        # = anchor build --arch v1  (program + IDL)
anchor run test         # build + cargo test
cargo fmt --check && cargo clippy --all-targets -- -D warnings   # what CI enforces
pnpm install
pnpm generate           # regenerate sdk/src/generated from target/idl/gatehook.json
pnpm typecheck          # tsc for sdk + scripts
pnpm test:sdk           # vitest (needs a fresh target/deploy/gatehook.so)
pnpm test:oracle        # oracle unit + integration tests
pnpm test               # all TS tests
CLUSTER=localnet pnpm --filter @gatehook/scripts create-mint|seed|demo-transfer
solana program deploy target/deploy/gatehook.so --program-id target/deploy/gatehook-keypair.json -ud   # upgrade devnet
cd oracle && docker compose up -d && cp .env.example .env   # then fill REGISTRY, API_KEY, MOCK_WEBHOOK_SECRET
pnpm --filter @gatehook/oracle start | dev:cli webhook <id> approved | db:generate
pnpm --filter @gatehook/portal dev | build | start | test
pnpm --filter @gatehook/sdk build && (cd sdk && pnpm pack)   # publishable tarball (dist/ via publishConfig)
```

### Conventions (do not break)

- **Build with `--arch v1`.** Anchor 1.2 defaults to SBPF v3, which is inactive on devnet/mainnet (checked 2026-10-14) and fails to load in LiteSVM. `cargo test` / `pnpm test:sdk` use the last built `.so` — rebuild first.
- **Error codes are client API.** `ComplianceError` is append-only; never reorder or remove variants.
- **Jurisdiction indices are on-chain data.** `sdk/src/jurisdictions.ts` is append-only; 0 = unset, 1 = US (= program `JURISDICTION_US`).
- **Account layouts** carry `version` + `reserved: [u8; 64]`; add fields by consuming reserved bytes.
- **Hook account order** (`execute`): 0 source, 1 mint, 2 destination, 3 authority, 4 extra-metas, 5 config, 6 registry, 7 sender identity (writable), 8 recipient identity. Identities derive from token-account **owners**, not the authority.
- **Keep in sync:** any rule change in `hook/execute.rs` must be mirrored in `sdk/src/preflight.ts` (same check order); parity is tested in `sdk/test/transfer.test.ts`. After any IDL change: `anchor run build && pnpm generate`.
- **Separation of powers:** only the oracle writes identities; admin controls config/pause/freeze/rotation. Admin-as-delegate transfers (clawback) skip sender rules, pause, caps and lockups but the **recipient must still pass holder checks**; they emit `TransferApproved { forced: true }`. The hook loads the recipient identity before the sender's — keep `sdk/src/preflight.ts` in the same order.
- **Program keypair** (`target/deploy/gatehook-keypair.json`) is gitignored; backup at `~/.config/solana/gatehook-program-keypair.json`. Devnet upgrade authority = deployer wallet `Dx7R…14g2`. Record every deploy in `docs/deployments.md`.
- **Generated SDK must match the IDL:** CI fails if `pnpm generate` changes `sdk/src/generated`.
- **Oracle never closes identities.** Revocation = upsert with `kycExpiry = 0` (preserves admin freeze + velocity). `revoke_identity` stays an admin tool.
- **Oracle jobs recompute state at run time** (`domain/reconcile.ts`); never put desired params in the job row. Pass the injected `now` into anything that writes timestamps compared by the worker.
- **Schema changes:** edit `oracle/src/db/schema.ts`, then `pnpm --filter @gatehook/oracle db:generate --name <change>`; commit the SQL.
- **SDK packaging:** in the workspace `@gatehook/sdk` exports TS sources; `publishConfig` swaps to `dist/` on pack/publish. Codama emits `.ts` import extensions (`importExtension: 'ts'`), rewritten to `.js` by `tsconfig.build.json`. Published deps use caret ranges, `@solana/kit` is a peer.
- **Error messages in apps:** use `getComplianceErrorMessage` (generated `sdk/src/generated/errorMessages.ts`); Codama's `getGatehookErrorMessage` returns a placeholder when `NODE_ENV=production`. Client code should pass kit errors through `portal/client/errors.ts`-style handling (kit strips messages in prod).
- **Portal secrets:** the oracle API key must only live in the portal server; demo env vars (`DEMO_*`) must never be set in production.
- **JS deps** pinned to exact versions at least 2 weeks old. Program code uses `error::ensure()` (not `require!`) when the error is chosen at runtime.
- Per milestone: update `plan.md` status, these docs and CCE (`record_decision` / `record_code_area`), then commit and push.
