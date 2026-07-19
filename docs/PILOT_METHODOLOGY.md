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
