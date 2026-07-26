# Pre-pilot band experiment — declared before it runs

*This is NOT the formal 30-day pilot. It is a bounded, pre-pilot shakedown experiment run
during the learning phase, declared here in the same spirit as PILOT_METHODOLOGY.md. Its
purpose is to test one hypothesis LIVE, with real (tiny, capped) capital, because proving
things by live trade is how this project learns.*

## The hypothesis

A tighter rebalance band — acting on ~2% price moves instead of the vol-scaled band's ~12% —
would improve results on the current sBTC-STX **full-range XYK** pool.

## The prior (what the model already predicts)

`analysis/band-cost.mjs`, calibrated to this pool (50bps swap fee, ~2.05%/day vol), predicts
the opposite: a band that triggers on a ~2% move fires ~30×/30d, and each rebalance's swap fee
equals ~100% of the drift it corrects — pure churn, because on a full-range pool tighter
rebalancing adds cost without adding fee revenue (fee income is volume × LP share, independent
of rebalance frequency). The live move of 2026-07-22→24 (a 16.5% sBTC/STX swing) is corroborating
evidence: inventory drift never exceeded 0.82%, and the vol band correctly *widened* (300→421bps).
So the expected result of this experiment is **a small, measured loss** — the point is to see it,
quantify it, and have it on the record rather than argued.

## The design (`src/m1/experiment.ts`)

- **Band:** pinned to `EXPERIMENT_BAND_BPS` = **50bps** (fires on a ~2% price move), with the
  vol-scaling override bypassed for the window so the band cannot auto-widen and mask the test.
- **Scope:** affects ONLY the rebalance band. The safety layer, LP logic, allocation, slippage
  guards, and per-trade size caps are all untouched.
- **Guardrails — three independent hard caps, whichever trips first ends the experiment and
  auto-reverts to the measured vol band, permanently:**
  - `EXPERIMENT_MAX_REBALANCES` = **8**
  - `EXPERIMENT_MAX_COST_STX` = **8 STX** (cumulative swap fees attributed to experiment rebalances)
  - `EXPERIMENT_MAX_DAYS` = **4**
- **Bounded downside:** ~8 STX (~$5–6) of tuition, the cost of seeing it live.
- **Persistence:** state is written to `journal/experiment.json` every cycle, so a VPS restart
  cannot reset the counters (a guardrail that resets on restart is no guardrail). `deploy/watch.sh
  sync` pulls it down as evidence.
- **Reversible instantly:** unset `EXPERIMENT_BAND_MODE` (or it auto-reverts on any cap).

## Honesty / brand

- **Distinct from the pilot.** `pilot-start` has not run; real pilot P&L still anchors at zero
  later, on the *final* strategy — this experiment does not contaminate the declared pilot.
- Every experiment cycle journals `experiment: "active: band 50bps | N/8 rebals | X/8 STX | day
  D/4"`; every executed rebalance journals its attributed fee. The closing verdict compares the
  live cost against the `band-cost.mjs` prediction — did reality match the model, or surprise us?
- This is not tightening the band to manufacture transaction count (which PILOT_METHODOLOGY.md
  rules out as wash-trading). It is a declared, bounded, one-time *measurement* of that exact
  cost, so the "don't tighten the band" rule rests on live evidence, not just a model.

## Config (set on the VPS `.env` to arm; absent = off)

```ini
EXPERIMENT_BAND_MODE=on          # arm the experiment (default off)
EXPERIMENT_BAND_BPS=50           # ~2% move trigger
EXPERIMENT_MAX_REBALANCES=8
EXPERIMENT_MAX_COST_STX=8
EXPERIMENT_MAX_DAYS=4
```

## VERDICT (armed 2026-07-24 14:21 → disarmed 2026-07-26 22:58)

Ran live for ~2 days and **4 rebalances**, then manually disarmed at 4/8 because the result
was already conclusive. Every rebalance is on-chain.

| When | Mid (STX/sBTC) | Fee | Action | Drift corrected |
|---|---|---|---|---|
| Jul 24 14:21 | 445,989 | 0.236 STX | sell sBTC | ~0.9% |
| Jul 25 01:53 | 466,115 | 0.312 STX | sell sBTC | ~1.1% |
| Jul 26 18:58 | 454,532 | 0.050 STX | buy sBTC | ~0.6% |
| Jul 26 22:29 | 449,009 | 0.050 STX | buy sBTC | ~0.7% |

**Total cost: 0.647 STX** to correct four small (0.6–1.1%) drifts.

**The counterfactual is the finding.** Over the identical window the **unpinned vol-band would
have done ZERO rebalances** — max drift only reached 2.17%, never near its ~4.3% trigger. So the
tight band spent **0.647 STX making four corrections the disciplined band correctly skips**: pure
tuition, zero benefit — exactly what `analysis/band-cost.mjs` predicted.

**And the prices show why:** 445,989 → 466,115 → 454,532 → 449,009 — the market **whipsawed up and
back down**. The tight band chased every wiggle (sold sBTC as it rose, bought it back as it fell),
paid a fee each time, and ended roughly where it started. Textbook "tight band on a full-range XYK
pool = churn on noise," now proven on-chain with real capital rather than argued from a model.

**Conclusions:**
1. The vol-scaled band is **correct discipline, not underperformance.** Holding through a 20%-swing
   week while a tight band bled 0.647 STX is the safety thesis working.
2. A tight rebalance band belongs on **concentrated liquidity (DLMM)**, where recentering *captures*
   fees, **not on full-range XYK**, where it only pays them. This experiment is the empirical
   justification for the concentrated-liquidity build.

**Disposition:** disarmed (`EXPERIMENT_BAND_MODE=off`), reverted to the vol-band, not to be repeated
on XYK. The `pilot-start` gate that waited on this experiment is now clear. Learning banked.
