# Velar PerpDEX spike — research-only assessment (M2 deliverable)

**Date:** 2026-07-18 · **Scope:** research only — no live capital, per the pilot plan.
**Question:** is perp market-making on Velar (Stacks) viable as DeepStack's phase-2 venue?
**Verdict: GATED — not viable in 2026. Revisit only when every condition in §4 is met.**

This executes the checklist in [VELAR_VERIFY.md](VELAR_VERIFY.md) against the live record.

## 1. Security status — fails the checklist

The Feb 19 2026 oracle-manipulation exploit (~$401k across Stacks + Mezo) remains the
controlling fact. Per the Mezo post-mortem (the most detailed public record):

- **Root cause:** the Pyth *pull* oracle updated prices on activity, the contracts had
  **no oracle price-timestamp checks**, and the attacker controlled activity because
  organic activity was near zero — ~$72M of self-dealt volume drained the pool slowly.
- **No pause / circuit-breaker** existed, despite being auditor-flagged pre-launch.
- The only published audit (Thesis Defense) covers the **EVM/Vyper** contracts.
  **No Stacks/Clarity audit has been published** as of this writing.
- No Stacks-specific remediation or relaunch announcement was found; the community-side
  response (REKT airdrop) addressed Mezo depositors, not root-cause fixes.

perpdex.velar.com is up (HTTP 200), but "the site loads" is not remediation evidence.
Checklist items in §2 of VELAR_VERIFY.md: all **unknown or no** → the gate holds.

## 2. Market status — no one to make markets for

Measured 2026-07-17/18:

| Metric | Value | Note |
|---|---|---|
| Velar AMM TVL | **$268k** | peak $5.16M (Apr 2024) → **−95%** |
| Velar spot 24h volume | **~$224** | CoinGecko; effectively zero |
| Perp volume (DefiLlama derivatives) | **not tracked** | no measurable book |

Market-making profits come from organic taker flow. A book with ~$224/day of spot
activity has none. Worse, on Velar the *absence* of flow was itself the attack vector —
a quiet book let the exploiter be 100% of activity and steer the oracle. An MM quoting
into that structure is the exit liquidity for the next such event.

## 3. The DeepStack lesson (why this spike still earned its keep)

The exploit is a case study in exactly the failure mode DeepStack's safety layer is built
against: **a venue price that can diverge from reality when one actor controls activity.**
DeepStack's oracle-sanity gate (external reference + divergence halt, fail-closed) and its
volatility-scaled band exist for precisely this class of event. The spike's practical
output is that those controls carry over unchanged as the *entry requirements* for any
future perp venue — plus one addition for leveraged venues: never quote on a book where
our own flow would be a majority of activity (the "are we the market?" check).

## 4. Re-entry conditions — all six, verified on-chain, before any capital

1. Published **Clarity** (Stacks) security audit with findings resolved
2. Oracle **timestamp/staleness checks** verifiably present in the deployed contracts
3. **Pause/circuit-breaker** deployed and documented
4. **New contract deployments** post-Feb-2026 (retired, not patched-around)
5. Organic perp volume sustained **>$100k/day** without incentives
6. Deposits/withdrawals open ≥90 days with no incident

Until then, DeepStack's perp-MM skills stay pointed at the venue where they already work:
the spot pool, where the agent is live.

## Sources

- Mezo post-mortem: mezo.org/blog/velars-perpdex-exploited-on-mezo
- Community response / REKT: mezo.org/blog/a-community-driven-response-to-velars-recent-exploit
- Velar EVM audit (Thesis Defense): docs.velar.com/velar/audits/perpdex-audit-on-evm
- TVL: DefiLlama `velar-amm` (api.llama.fi/protocol/velar-amm)
- Spot volume: CoinGecko exchange page `velar-stacks`
- Site liveness: perpdex.velar.com (HTTP 200, 2026-07-18)
