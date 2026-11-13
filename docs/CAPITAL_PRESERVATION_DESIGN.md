# Capital-preservation mode: design (draft for review)

*Status: design only. Nothing here is built or live. Written 2026-11-13 for review by the
maintainers before any code. Backtest figures are simulations on historical prices, not
results, and are labelled as such wherever they appear.*

## 1. Why

DeepStack's stated purpose is to protect capital first ([ALLOCATION.md](ALLOCATION.md): "depositors
don't fear missing upside, they fear losing capital in a crash"). Today only half of that is live:

- **Execution safety is live**: post-conditions, min-outs, oracle and drawdown gates, kill switch.
  It protects against bad transactions, bugs and manipulation.
- **Market-risk protection is not**: `ALLOCATION_MODE` has been `static` since the pilot, the
  stablecoin rotation in `haven.ts` is dormant, and the DLMM position (about 83% of capital in
  November 2026) has no defensive behaviour at all. Its recenters follow the price down.

A backtest of the current concentrated-liquidity strategy (2026-11-12) found that recentering a
tight range locks in impermanent loss on every exit, in rising and falling markets alike. At the
fee levels the agent has measured, that loss is larger than the fees. Liquidity provision is
therefore not the safety mechanism; at most it is a small yield sleeve.

## 2. The rule

Hold a risk asset (sBTC) and a stable asset (USDCx). Every day, at a fixed UTC time, compare the
daily BTC/USD close with its 60-day simple moving average (SMA60):

| State | Holdings | Switch when |
|---|---|---|
| **Risk-on** | 50% sBTC / 50% USDCx by value | close < SMA60 x 0.98 -> risk-off |
| **Risk-off** | 100% USDCx | close > SMA60 x 1.02 -> risk-on |

The 2% buffer stops the rule flipping on noise. At most one switch per day.

### Evidence (simulated, pre-registered 2026-11-13 before any result was seen)

Rolling one-year windows; 0.5% cost per switch; cash earning nothing.

| | BTC 2019-01 to 2024-11 | ETH 2019-01 to 2026-11 |
|---|---|---|
| Windows with a smaller worst fall than holding 50/50 | 98% | 94% |
| Windows losing more than 20% (rule vs hold) | 5% vs 14% | 2% vs 15% |
| Worst fall over the whole period (rule vs hold) | 36% vs 73% | 43% vs 77% |
| Total return (rule vs hold) | +629% vs +1,046% | +628% vs +693% |

Every setting tested (averages of 20 to 200 days, buffers of 0 to 5%) cut the worst fall in at
least 71% of windows. **The cost is upside**: the average one-year window ended about 7% (BTC) to
29% (ETH) below holding, because whipsaws sell low and buy back higher. Falls are reduced, not
removed: the rule acts on daily closes, after a fall has started.

### Volatility targeting: tested, not adopted (pre-registered 2026-11-13)

Scaling the sBTC share down when 20-day volatility is above 50% a year (`validate_vol.py`) was
tested against the trend rule alone, with pass criteria written down first. It **failed**: it cut
the worst fall further (BTC 36% to 30%, ETH 35% to 23%, with the same or fewer >20% losses), but
the average one-year return fell 9 to 13 points below the trend rule, against an allowed 3. It
does not react earlier in a useful way; it is a risk dial (smaller falls for less return), the
same trade-off as a lower risk share (open question 1). Volatility alone, without the trend rule,
was worse than the trend rule on large losses. The design keeps the trend rule only.

What may be said publicly: "a trend rule that, in historical simulations, roughly halved the worst
falls at the cost of some upside". Not a return figure, and never "safe" without that qualifier.

## 3. Components

### 3.1 Price signal (fail closed)
- Daily close: BTC/USD from two independent sources, reusing the oracle work in #67 (DefiLlama plus
  a second source). If they disagree by more than 1%, or either is stale, there is **no decision
  that day**: the agent stays in its current state and alerts.
- History: `journal/trend-closes.json` (date, close, sources). Bootstrapped once from DefiLlama's
  daily chart, cross-checked against the second source on overlapping days. The SMA is not computed
  until 60 verified closes exist.
- The on-chain sBTC/USDCx pool price must also agree with the reference (existing
  `REBALANCE_MAX_DIVERGENCE_BPS`, 3%) before any swap.

### 3.2 State machine (pure, unit-tested)
`decideTrend(closes, state, params) -> { state, action: "hold" | "to-risk-off" | "to-risk-on", reason }`.
Persisted in `journal/trend-state.json` (atomic write; unreadable file = no decision, alert),
following the C7 pattern of #55.

### 3.3 Execution
- Swaps through the sBTC/USDCx HODLMM pool, reusing the DLMM rebalance path: chunks of at most
  $600 (`DLMM_REBALANCE_CHUNK_VALUE_Y`), 1% slippage, deny-mode post-conditions, KILL re-checked
  before every broadcast, nonce gate.
- A switch that cannot finish in one cycle is saved as a pending switch and resumed, like the
  pending re-add. Three aborted swaps in a row stop it until a human looks.
- Target after a switch: within 2% of the intended split, not exact.

### 3.4 What happens to the current positions
- **DLMM sBTC/USDCx**: withdrawn when the mode goes live. Its capital becomes the 50/50 (or
  100% USDCx) holding. No automatic re-opening.
- **XYK sBTC/STX** (about $580): out of scope for the first version; the owner chose to leave it.
  Its STX exposure is not protected by this rule and the dashboard says so.
- **Liquidity sleeve (later, optional)**: at most 20% of capital, only while risk-on, range ±50,
  withdrawn on every switch to risk-off. Only after the core has run for a month.

### 3.5 Limits
- Lifetime and per-30-day switch caps (default 6 per 30 days); exceeding them halts the mode and
  alerts, since that many switches means bad data or an extreme market.
- Existing gates still apply: safety verdict, drawdown, circuit breaker, KILL.
- Switches are sized from the agent's own capital only; the XYK side's sBTC is never touched
  (same wallet-delta discipline as the DLMM re-add).

### 3.6 Settings
`TREND_MODE=observe|live` (default observe), `TREND_SMA_DAYS=60`, `TREND_BUFFER=0.02`,
`TREND_RISK_SHARE=0.5`, `TREND_MAX_SWITCHES_30D=6`, `TREND_DECISION_UTC_HOUR=0`.

### 3.7 Reporting
- Dashboard: current state, close vs SMA60 and the distance to each switch line, switch log with
  transaction ids, and performance against two benchmarks: holding 50/50 and 100% USDCx.
- Journal entry every day, including the no-decision days and why.

## 4. Rollout
1. Review of this design (owner and Hillary).
2. Build behind `TREND_MODE=observe`: the agent logs what it would do each day; nothing is sent.
   Tests: the state machine, the price fail-closed cases, and the swap path through the existing
   fault harness.
3. Observe for at least 14 days; compare the logged decisions with an independent recomputation.
4. Public note before going live (README, dashboard): the strategy change, what it does, the
   upside it gives up, and that the XYK position is not covered.
5. Go live with the owner's capital, attended for the first switch.

## 5. Open questions
1. Risk share: 50% sBTC in risk-on, or less (for example 30%) for a smaller worst fall?
2. Idle USDCx: hold it, or lend it (Zest USDCx about 1.6%) at the cost of another contract's risk?
3. Should STX be covered (via the STX/USDCx pool), or left out as in v1?
4. Decision frequency: daily close (tested) only, or also an intraday emergency exit on a large fall
   (untested; would need its own validation before use)?
5. Interaction with vault v3: this mode is the natural strategy for the vault; the vault design note
   should be updated once v1 has run.

## 6. Reproducing the evidence
The backtest scripts and the pre-registration note will be added under `research/trend-rule/`
with the data sources, so anyone can rerun them.
