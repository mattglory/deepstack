# Analysis — why the rebalance band is volatility-scaled

Reproducible models behind the agent's band design (`applyVolBand`, see
`src/m1/agent-cli.ts`). No dependencies; run with `node`.

## rebalance-frequency.mjs

How often does an honestly sized band actually trade? Inventory drift after a 50/50
rebalance is exact in the mid's log-return `r`: `drift = -tanh(r/2)/2`, so a band `B`
triggers at a mid move of `R = 2·atanh(2B)`. With Brownian `r` (variance σ²/day), expected
first passage is `E[T] = R²/σ²`. A 20k-trial Monte Carlo at the agent's real 30-minute
sampling confirms the analytics.

Key result: with the k=6 volatility-scaled band, `E[T] ≈ 36 days` **regardless of σ** —
the band scales with volatility, so trade frequency is σ-independent by construction. Over
30 days: median **1** rebalance, ~47% chance of zero. An inventory agent on a calm pool
*should* be quiet; frequency is not a quality signal.

```
node analysis/rebalance-frequency.mjs
```

## band-cost.mjs

The converse: what band would be needed to *force* a given trade count, and what would it
cost? The pool charges 50bps per swap, paid on every rebalance. As the band tightens, the
fee consumes the deviation being corrected — at ~56bps (≈25 trades/30d) the fee eats 89%
of the drift corrected, and past ~40bps the cure costs more than the disease. Tightening
the band to generate activity is churn, not inventory management; the agent will not do it.

```
node analysis/band-cost.mjs
```

Realised σ is measured from the agent's own mid history (`src/m1/lvr.ts`); σ=2.05%/day in
these scripts was the sBTC-STX pool's measured value when the band design was fixed
(July 2026).
