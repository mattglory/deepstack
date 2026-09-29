# Pilot methodology — declared before the window opens

*Written 2026-07-19, ahead of the 30-day pilot (window opens ~mid-August via
`m2:pilot-start`, which anchors it irreversibly). This document pre-declares every
planned action and measurement rule so the results post reports against commitments
made in advance — not criteria fitted to outcomes afterwards.*

## What runs

One autonomous agent on the Bitflow sBTC-STX XYK pool, 30-minute cycles, strategy fixed
for the whole window: 50/50 inventory target with a volatility-scaled rebalance band,
~25–33% of portfolio as an actively-managed LP position, and the safety layer
(oracle-sanity halt, drawdown halt, hard caps, pool-share cap, kill switch) unchanged
throughout. No capital enters or leaves the wallet during the window — funding completed
beforehand, precisely so the vs-HODL baseline stays comparable.

## Execution timing (declared)

When the band requires a rebalance, the agent may defer execution up to **6 cycles
(~3 h)** waiting for pool-vs-reference divergence to favour the trade, journalling each
deferral with the measured edge. Deferral is bounded and risk-capped: urgent drift
(>1.5× band) or an exhausted budget executes immediately regardless of edge. This
changes *when* a required trade happens — never whether, nor its size. Captured
execution edge is reported separately in the results.

## Planned discretionary actions (declared, each journalled with rationale)

1. **One mid-pilot LP allocation adjustment** (a reasoned change to the LP target)
   — legitimate active management, producing a real add or withdraw.
2. **A partial LP unwind in the final week** — demonstrating the exit procedure
   end-to-end as part of the results.
3. **Opportunistic FlashStack flash-rebalance(s)** when genuine inventory drift makes
   the atomic path the correct correction.

Nothing else discretionary. Specifically ruled out: tightening the band to manufacture
transaction count (analysis of why that is wash-trading: `analysis/band-cost.mjs`),
capital top-ups mid-window, strategy or parameter-clamp changes.

## What is measured (all regenerable from journal + telemetry via `m2:pnl`)

- **Uptime**: heartbeats vs expected at the declared 30-min cadence
- **Decision census**: every cycle's decision incl. HOLDs, halts, deferrals, errors
- **P&L vs HODL** (IL-adjusted) from the window-anchored baseline
- **LP economics**: fees net of impermanent loss vs the deposited-legs basis; APR only
  over the full window
- **Divergence record**: arb opportunities observed (detection only) and cross-pool
  spreads sampled every cycle — the dataset for the post-pilot capture decision
- **Costs**: every network and pool fee paid

## Honesty rules

Failures are reported as prominently as successes. A quiet pilot (few trades) is the
*correct* outcome of a correctly-sized band on a calm pool and will be reported as such,
with the model that predicts it (`analysis/rebalance-frequency.mjs`). All numbers are
independently verifiable: transactions on-chain, telemetry public, analysis scripts
reproducible.

## Change log — deviations from this document, dated (added 2026-09-29)

This document was never amended during the pilot, so what actually ran is not, on its
own, formally comparable to what it declares above. Added after external review flagged
the gap (Hillary Kibet): every mid-window change, and the one thing this document should
have named from the start and didn't.

**Scope gap, present from before the pilot opened.** "What runs" above names only the
Bitflow sBTC-STX XYK pool. A DLMM position on Bitflow's sBTC-USDCx pool existed before
the pilot window opened and traded throughout it (25 `add-liquidity-multi`, 9
`withdraw-liquidity-multi`, 16 aborted, in-window) — none of that is a violation of
anything declared here, because this document simply never named the DLMM leg as part
of "what runs" at all. That omission is on this document, not on the DLMM activity
itself, which is disclosed in full in `docs/PILOT_RESULTS.md`.

**Pre-anchor, not mid-window (informational):**
- `589ee59` (2026-08-28T20:37:21Z, **22 minutes before** the 20:59:43Z anchor) — raised
  the per-swap rebalance cap 5x (10→50 STX). Before the window opened, so not a
  mid-pilot strategy change under this document's own rule, but close enough to the
  anchor to disclose precisely rather than let the timing look coincidental.

**Mid-window changes (after the anchor):**
- `1e97f88` (2026-09-19) — made the DLMM recenter width volatility-adaptive, matching
  how the XYK band already worked. This is a genuine sizing-methodology change to the
  DLMM leg, made mid-window. Defensible on the merits (same vol-scaling principle the
  XYK band was declared with, not a tightening-for-tx-count move — the DLMM leg
  narrows or widens with realised volatility both directions), but it is a change this
  document didn't declare in advance for DLMM specifically, because DLMM wasn't named
  as in-scope to begin with. Same root cause as the scope gap above.
- `23e7cfb` (2026-09-19) — added nonce-gap safety and a circuit breaker on repeated
  cycle failures. A safety-layer addition, not a strategy or parameter-clamp change;
  the "strategy fixed for the whole window" rule is about what the agent *decides*, not
  whether new ways to fail safely can be added. Judgment call, stated so the reader can
  disagree.
- `6b46d42` (2026-09-22) — fixed the per-bin sizing bug behind the 2026-09-21 DLMM
  add-liquidity failure loop (see `docs/PILOT_RESULTS.md`, Lessons Learned). A bug fix
  restoring intended behavior (each bin was supposed to size its own minimum, and now
  does), not a strategy change.
- `50d9b47`, `1d90fad` (2026-09-22) — cost-basis and HODL-baseline correctness fixes to
  the *measurement* layer (what gets reported), not the trading strategy itself. Covered
  under "What is measured," not "What runs" — but noted here for completeness since they
  changed numbers this document implicitly promised would be measured one fixed way.
- The DLMM safety-gate fix (`f1ec66c`, 2026-09-28) is a fifth change of this kind, landed
  after the pilot closed — see `docs/PILOT_RESULTS.md`'s Lessons Learned for the full
  account; not repeated here since it postdates the window this document governs.

**What this changelog does not claim:** that every one of these was harmless to the
letter of "strategy fixed for the whole window." `1e97f88` specifically is a real
judgment call, not a clean pass. The honest position is that the *safety* and
*measurement* fixes are clearly in bounds, the DLMM scope gap is this document's own
omission rather than a deviation by the agent, and the one genuine sizing-methodology
change (`1e97f88`) is disclosed for the reader to weigh rather than argued away.
