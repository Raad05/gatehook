# Gatehook investor portal (demo)

Reference investor portal for a Gatehook token: sign in → verify identity → link a wallet →
hold and transfer, with the hook's rules checked live before every transfer.

```
browser (React, @gatehook/sdk, wallet)  ──/api──▶  portal server (Fastify)  ──API key──▶  oracle
          │                                              │ (holds ORACLE_API_KEY)
          └──────────── Solana RPC (reads, transfers) ───┴──────────────▶ Gatehook program
```

The oracle API key stays on the portal server; the browser only talks to `/api/*` and to
Solana RPC.

## What is real and what is simulated

| Piece | Status |
|---|---|
| Wallet connection | Real: Wallet Standard extensions (Phantom, Solflare, Backpack…) or a **burner wallet** stored in localStorage (testing only) |
| Wallet ownership proof | Real: ed25519 signature over the oracle's single-use challenge |
| On-chain identity, balances, transfers, preflight | Real, via `@gatehook/sdk` |
| Sign-in | **Demo:** any email; in-memory sessions. Replace with your investor auth. |
| KYC | **Demo:** "Complete KYC" sends a signed mock-provider webhook. Replace with your provider's widget; the provider then calls the oracle directly. |
| Faucet | **Demo:** 0.01 SOL + 100 tokens from the issuer treasury to linked wallets. |

## Run against devnet

Needs a running oracle for the token's registry (see the root README) whose
`MOCK_WEBHOOK_SECRET` and `API_KEY` you know.

```bash
cd portal
cp .env.example .env    # ORACLE_API_KEY, PORTAL_MINT, DEMO_MOCK_WEBHOOK_SECRET, DEMO_FAUCET_KEYPAIR
pnpm build && pnpm start          # http://127.0.0.1:8788
# or: pnpm dev                    # server on 8788 + Vite on 5173 with hot reload
```

The public devnet RPC rate-limits browsers; set `RPC_URL` to a dedicated endpoint for anything
beyond a quick demo.

## API (portal server)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/config` | – | cluster, RPC URL, mint, enabled demo features |
| `POST /api/session` | – | demo sign-in `{ email }` → `{ token }` |
| `GET /api/status` | session | applicant + linked wallets + latest oracle job per wallet |
| `POST /api/kyc` | session | demo KYC `{ status, tier, country }` |
| `POST /api/wallet/challenge` | session | `{ wallet }` → message to sign |
| `POST /api/wallet/link` | session | `{ wallet, nonce, signature }` (base58) |
| `POST /api/demo/faucet` | session | `{ wallet }` (must be linked to the session's applicant) |

Tests (`pnpm test`) run the server against a real in-process oracle (PGlite + LiteSVM).
