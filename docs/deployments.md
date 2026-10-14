# Deployments

## Devnet

Deployed 2026-10-14.

| Item | Value |
|---|---|
| Program | `HbNmR9zK6d4BMBgzEWixgp6L3QZh4aP66Am13MXsBkaA` |
| ProgramData | `56p1Zd68VgRoP265ivSmXWGdYebkSTYGSWzsZFjtAR55` |
| Upgrade authority | `Dx7RPXNY6qwLY7352Wh5NyatNTSwssmcFiN4Bphs14g2` (deployer wallet) |
| Deploy tx | `E88Z21TMe2GnEmM7zAaNLvGSfwqpeDgJBhT5hjFP6PRTpUK81UL8zBV3LT4TEYKLpnKxwKoCUNEk1T5MJzZnchc` (slot 510969569) |
| Binary | SBPF v1, `sha256 16170321caa8dd1ef3e798f9f6584520282d4fc832f384464a42b2c4dc5a6456` |
| IDL | on-chain via program metadata: `anchor idl fetch HbNm…kaA --provider.cluster devnet` |

The program keypair (`target/deploy/gatehook-keypair.json`) is gitignored. Its backup
lives with the deployer (`~/.config/solana/gatehook-program-keypair.json`); keep it, as
it is needed to redeploy to the same address on a fresh checkout.

Upgrade: `anchor run build && solana program deploy target/deploy/gatehook.so --program-id target/deploy/gatehook-keypair.json -ud`
(the upgrade authority signs). If the binary grows past the allocated length, run
`solana program extend HbNm…kaA <bytes> -ud` first.

### Demo issuer (from `scripts/`)

Issuer, registry admin and oracle are all the deployer wallet.

| Item | Address |
|---|---|
| Registry | `BvyoYAfvguQDGudyEEcEhu9P6dWSWSKPZWd3wSkR6qCn` |
| Mint "Gatehook Demo T-Bill" (GTB, 6 dp) | `E2p6riTZ82UnDQuLCi1jEc4F1Pc8kZE36exCTJ198Gc1` |
| ComplianceConfig | `4toqZj1vVafQYWg4C4SUjzZokFys7QgvqiVgWBhSo54Y` |
| ExtraAccountMetaList | `4gGrrEGZrCRp7tDtZxCefcosJafjxr1iXK6fs7FcpxPJ` |
| Treasury ATA (Issuer tier) | `EmuAfumeAVhLaL3Kh76pKkzVPE6z8UVxXq5E3PMpdFie` |
| alice (US, Reg D) | `EuixfFig28R4WAr9cP6QNgvvtBZ78rko23oaW9KcqSas` |
| bob (DE, Reg S) | `HjQo8ah5wX7dAu2HLsWxoiTwhrtDgNyaYgKnSCBAUMpD` |
| mallory (no identity) | `Cq7riEC6jQqrBGzC8A65WxteZTPRGpMzvTFgbxsu7Z9M` |

Rules: US/DE/GB/SG, all investor tiers, 30-day Reg S period, 1,000,000 GTB/day velocity
for Reg D. Demo run: treasury → alice and alice → bob confirmed; alice → mallory rejected
with `RecipientIdentityNotFound` (6011).

## Mainnet

Not deployed. Prerequisites are tracked in [`issuer-runbook.md`](issuer-runbook.md#mainnet-checklist).
