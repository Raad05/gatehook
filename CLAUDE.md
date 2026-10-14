<!-- cce-block-version: 4 -->
## Context Engine (CCE)

This project uses Code Context Engine for intelligent code retrieval and
cross-session memory.

### Searching the codebase

**You MUST use `context_search` instead of reading files directly** when
exploring the codebase, answering questions about code, or understanding how
things work. This is a hard requirement, not a suggestion. `context_search`
returns the most relevant code chunks with confidence scores instead of whole
files, and tracks token savings automatically.

When to use `context_search`:
- Answering questions about the codebase ("how does X work?", "where is Y?")
- Exploring structure or architecture
- Finding related code, functions, or patterns
- Any time you would otherwise read a file just to understand it

When to use `Read` instead:
- You need to edit a specific file (read before editing)
- You need the exact, complete content of a known file path

Other search tools:
- `expand_chunk` — get full source for a compressed result
- `related_context` — find what calls/imports a function

### Cross-session memory — use it actively

This project has persistent memory across Claude Code sessions. **You must
use it both ways: recall before answering, record after deciding.** Memory
that is not recorded is lost; memory that is not recalled does nothing.

**Before answering a non-trivial question, call `session_recall`.**
Especially when:
- The question touches architecture, design, or naming choices
- The user asks "what / why / how did we ..."
- You are about to recommend an approach the team may have already chosen
  or already rejected

Pass a topic phrase, not a single word — e.g. `session_recall("auth flow")`,
not `session_recall("auth")`. Recall is vector-similarity-based, so paraphrases
match. If recall returns relevant entries, lead with them ("Per a prior
decision: ...") instead of re-deriving the answer.

**After making a non-obvious decision, call `record_decision`.** Especially:
- Choosing one library / pattern / approach over another
- Resolving an ambiguity in the spec or requirements
- Establishing a convention the project should follow going forward
- Anything you would not want to re-litigate next session

Format: `record_decision(decision="...", reason="...")`. Keep both fields
short and specific — they are surfaced verbatim at the start of future
sessions.

**After meaningful work in a file, call `record_code_area`.** Especially when:
- You added or substantially modified a function/class
- You traced through a non-obvious flow and want future-you to find it fast

Format: `record_code_area(file_path="...", description="...")`.

Skip recording for trivial reads, formatting changes, or one-off lookups —
the goal is durable signal, not an event log.

### Drilling deeper from a recall hit

`session_recall` results are tagged with the source session id, e.g.
`[turn sid:abc123|n:5]`. To drill in:

- `session_timeline(session_id="abc123")` — walk the per-turn summaries of
  that session in order. Use this when the user asks "what was the
  reasoning?" or "how did we get there?".
- `session_event(event_id=N)` — fetch a specific tool event's raw input
  and output (capped at 4 KB at read time). Use this when a turn summary
  references a tool result you actually need to inspect.

Both are read-only and cheap. Prefer them over re-running tool calls or
asking the user to re-paste context.

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
<!-- /cce-block -->

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
