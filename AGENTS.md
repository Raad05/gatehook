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
- `scripts/` — issuer CLI: `create-mint`, `seed`, `demo-transfer` (state in gitignored `scripts/.state/`)
- Planned: `oracle/` (KYC oracle service, milestone 5)

### Commands

```bash
anchor run build        # = anchor build --arch v1  (program + IDL)
anchor run test         # build + cargo test (59 Rust tests)
pnpm install
pnpm generate           # regenerate sdk/src/generated from target/idl/gatehook.json
pnpm typecheck          # tsc for sdk + scripts
pnpm test:sdk           # vitest (needs a fresh target/deploy/gatehook.so)
CLUSTER=localnet pnpm --filter @gatehook/scripts create-mint|seed|demo-transfer
```

### Conventions (do not break)

- **Build with `--arch v1`.** Anchor 1.2 defaults to SBPF v3, which is inactive on devnet/mainnet (checked 2026-10-14) and fails to load in LiteSVM. `cargo test` / `pnpm test:sdk` use the last built `.so` — rebuild first.
- **Error codes are client API.** `ComplianceError` is append-only; never reorder or remove variants.
- **Jurisdiction indices are on-chain data.** `sdk/src/jurisdictions.ts` is append-only; 0 = unset, 1 = US (= program `JURISDICTION_US`).
- **Account layouts** carry `version` + `reserved: [u8; 64]`; add fields by consuming reserved bytes.
- **Hook account order** (`execute`): 0 source, 1 mint, 2 destination, 3 authority, 4 extra-metas, 5 config, 6 registry, 7 sender identity (writable), 8 recipient identity. Identities derive from token-account **owners**, not the authority.
- **Keep in sync:** any rule change in `hook/execute.rs` must be mirrored in `sdk/src/preflight.ts` (same check order); parity is tested in `sdk/test/transfer.test.ts`. After any IDL change: `anchor run build && pnpm generate`.
- **Separation of powers:** only the oracle writes identities; admin controls config/pause/freeze. Admin-as-delegate transfers (permanent-delegate clawback) bypass holder rules and emit `TransferApproved { forced: true }`.
- **JS deps** pinned to exact versions at least 2 weeks old. Program code uses `error::ensure()` (not `require!`) when the error is chosen at runtime.
- Per milestone: update `plan.md` status, these docs and CCE (`record_decision` / `record_code_area`), then commit and push.
