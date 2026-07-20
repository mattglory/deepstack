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

## Paper quoting — what DeepStack's quotes would look like on Velar

The gate verdict is "do not deploy," but the grant criterion asks for **paper quoting** — a
worked model of the quotes the agent *would* post — so here it is. This is a spreadsheet
exercise, not live capital (none is deployed, per the research-only mandate).

**Setup.** A perp market maker quotes a two-sided spread around a reference mark and manages
inventory as fills arrive. DeepStack's spread would be sized the same way its spot band is:
from measured volatility, not guessed. Modelled on the sBTC-USDh perp (Velar's launch pair),
using the sBTC vol the agent already measures (~2%/day realised).

**Quote model.**
- **Reference mark:** the same external oracle the safety gate uses (CoinGecko/Pyth BTC),
  not the venue's own mark — the Feb-2026 exploit is the reason we never trust the venue's
  internal price as the reference.
- **Half-spread:** `k · σ_perhold + fee + inventory_skew`. At σ ≈ 2%/day and a ~1-hour quote
  refresh, per-hold σ ≈ 0.41%; with k = 1.5 for adverse selection, base half-spread ≈ 62 bps,
  so a **~124 bps two-sided quote** before fees.
- **Inventory skew:** shift the mid against the side we're long, same logic as the spot
  target — a position 20% long BTC skews quotes ~15–25 bps to encourage mean-reverting fills.
- **Size:** capped per level at a small fraction of free margin, laddered — never the whole
  book at one price (the spot per-tx caps carry over).

**Illustrative quote (paper, BTC = $64,800, σ = 2%/day):**

| | Bid | Ask |
|---|---|---|
| Balanced inventory | 64,760 (−62 bps) | 64,840 (+62 bps) |
| 20% long BTC | 64,740 (−93 bps) | 64,820 (+31 bps) → lean to sell |

**Why the paper model itself argues against going live** (the feasibility finding, quantified):
1. **The spread can't clear the adverse selection.** With ~$224/day of organic volume,
   almost all flow into a quote this wide would be informed/toxic — the same dynamic that
   let the exploiter be 100% of activity. A 124 bps spread sounds wide until you realise the
   only takers are arbitrageurs picking off a stale mark.
2. **Funding + no hedge venue.** Holding perp inventory means paying/earning funding with no
   deep spot venue on Stacks to hedge the delta — inventory risk compounds instead of
   netting out.
3. **The reference-mark dependency is the whole risk.** The model *works on paper* only
   because it quotes around an external oracle; the moment that oracle is unavailable or
   manipulable (the exploit's root cause), the quotes become the attacker's payout function.

**Recommended next steps (unchanged by the paper exercise, now quantified):** stay gated on
the six §4 conditions. If Velar relaunches with a published Clarity audit, timestamp checks,
a circuit breaker, and sustained organic volume, re-run this quote model against live depth
and funding before risking capital — and only then with Stacks Endowment approval per the
research-only clause. Paper quoting confirms the venue is *modellable* but not *investable*.

## Sources

- Mezo post-mortem: mezo.org/blog/velars-perpdex-exploited-on-mezo
- Community response / REKT: mezo.org/blog/a-community-driven-response-to-velars-recent-exploit
- Velar EVM audit (Thesis Defense): docs.velar.com/velar/audits/perpdex-audit-on-evm
- TVL: DefiLlama `velar-amm` (api.llama.fi/protocol/velar-amm)
- Spot volume: CoinGecko exchange page `velar-stacks`
- Site liveness: perpdex.velar.com (HTTP 200, 2026-07-18)
