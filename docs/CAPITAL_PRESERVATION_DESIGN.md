# Capital-preservation mode: design

*Status: design only. Nothing here is built or live. First draft 2026-11-13; revised 2026-11-17
after review on #90 (findings R90-1 to R90-7 and the answers to the open questions), which this
version adopts. Backtest figures are simulations on historical prices, not results, and are
labelled as such wherever they appear.*

## 1. Why

DeepStack's stated purpose is to protect capital first ([ALLOCATION.md](ALLOCATION.md): "depositors
don't fear missing upside, they fear losing capital in a crash"). Today only half of that is live:

- **Execution safety is live**: post-conditions, min-outs, oracle and drawdown gates, kill switch.
  It protects against bad transactions, bugs and manipulation.
- **Market-risk protection is not**: `ALLOCATION_MODE` has been `static` since the pilot, the
  stablecoin rotation in `haven.ts` is dormant, and the DLMM position has no defensive behaviour at
  all. Its recenters follow the price down.

A backtest of the current concentrated-liquidity strategy (2026-11-12) found that recentering a
tight range locks in impermanent loss on every exit, in rising and falling markets alike. At the
fee levels the agent has measured, that loss is larger than the fees. Liquidity provision is
therefore not the safety mechanism; at most it is a small yield sleeve.

## 2. The rule

Hold a risk asset (sBTC) and a stable asset (USDCx). Once a day, compare the completed daily BTC/USD
close (section 3.1) with its 60-day simple moving average (SMA60):

| State | Holdings | Switch when |
|---|---|---|
| **Risk-on** | **30% sBTC** / 70% USDCx by value | close < SMA60 x 0.98 -> risk-off |
| **Risk-off** | 100% USDCx | close > SMA60 x 1.02 -> risk-on |

The 2% buffer stops the rule flipping on noise. At most one switch per day. The switch trades after
the close that produced the signal, never at it.

**Why 30%, not 50% (review answer 1).** Besides a smaller worst fall, each risk-off switch sells 40%
less sBTC, so fewer chunks have to clear a thin pool at the moment it matters (R90-1). The share can
rise once observe mode has logged real exit capacity through a few falls.

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

**Deviation from the pre-registration (R90-5).** It named BTC from 2017-01 and ETH from 2017-01.
DefiLlama's daily series starts in mid-2018, and the 200-day average needs history before the first
window, so the evaluated periods begin in January 2019. Noted in `research/trend-rule/PREREGISTERED.md`.

### Post-review re-run (2026-11-17, `revalidate.py`)

The pre-registered script traded at the same close that produced the signal, a mild look-ahead
(R90-5). Re-run with the switch trading at the next day's close, and at the agreed 30% share:

| | BTC: worst fall (hold) | BTC: windows with a smaller fall | ETH: worst fall (hold) | ETH: windows with a smaller fall | Windows losing >20% (rule / hold) |
|---|---|---|---|---|---|
| 50%, same day (as pre-registered) | 36% (73%) | 98% | 43% (77%) | 94% | 5% / 14%, 2% / 15% |
| 50%, next day | 38% (73%) | 84% | 42% (77%) | 94% | 5% / 14%, 1% / 15% |
| **30%, next day (v1)** | **28% (68%)** | **88%** | **30% (74%)** | **96%** | **0% / 3%, 0% / 2%** |

Next-day execution costs some of the edge (BTC: 98% to 84% of windows; the average one-year return
gap widens from about 7 to 15 points at 50%), but the rule still clears the pre-registered 70% bar.
At 30%, no one-year window in either set lost more than 20%.

### Volatility targeting: tested, not adopted (pre-registered 2026-11-13)

Scaling the sBTC share down when 20-day volatility is above 50% a year (`validate_vol.py`) was
tested against the trend rule alone, with pass criteria written down first. It **failed**: it cut
the worst fall further (BTC 36% to 30%, ETH 35% to 23%, with the same or fewer >20% losses), but
the average one-year return fell 9 to 13 points below the trend rule, against an allowed 3. It is a
risk dial (smaller falls for less return), the same trade-off as a lower risk share. Volatility
alone, without the trend rule, was worse than the trend rule on large losses.

**Public wording.** "A trend rule that, in historical simulations, roughly halved the worst falls at
the cost of some upside." Not a return figure, and never "safe" without that qualifier.

## 3. Prerequisites (before any trading code)

### 3.1 Per-venue token reservation (R90-2, R89-2)
The XYK position, the DLMM position and this mode share one wallet, and nothing records which tokens
belong to which. The 14-15 Nov incident (the XYK step trading a pending DLMM re-add's tokens) is the
acute case; the daily case is recenter leftovers drifting into the XYK. This mode would add a third
claimant on the same sBTC and USDCx. **Define and build the accounting first:** each venue has a
reserved balance, derived from its own recorded state (pending re-adds, deposits, this mode's
holdings and pending switch), and every step sizes only from the unreserved remainder. Tested in the
DLMM fault harness (#66). #91 and #95 are the stopgap for one case of this.

### 3.2 Oracle hardening (#67) merged
The execution-time reference (#67: CoinGecko and DefiLlama read together, each at most 15 minutes
old, within 2% of each other, failing closed) guards every swap of this mode.

## 4. Components

### 4.1 Price signal
- **The close is the tested series.** The signal uses DefiLlama's completed daily point
  (`chart/coingecko:bitcoin`, period 1d), the series the backtest used, not a spot reading at the
  decision hour. Each stored close keeps its source timestamp.
- **An independent second source.** DefiLlama's `coingecko:` prices can draw on CoinGecko, so the two
  are close to one source. Each close is cross-checked against an exchange daily candle (Coinbase or
  Kraken BTC-USD, public) or Pyth BTC/USD at the same timestamp (Pyth is what v3 uses on chain).
  Agreement within 1%.
- **Asymmetric "no decision".** Staying risk-on through a crash because a feed is down is the failure
  that matters:
  - **to risk-off** may proceed on one fresh source if the on-chain sBTC/USDCx pool price agrees with
    it within the existing 3% bound (a wrong move costs upside, not capital);
  - **to risk-on** needs both sources and the pool check;
  - two or more no-decision days in a row escalate the alert.
- **Append-only history** in `journal/trend-closes.json`. A verified close is never rewritten; a late
  correction from a source is logged and alerted, not applied (one bad close moves SMA60 by 1/60).
- No SMA until 60 verified closes exist.

### 4.2 State machine (pure, unit-tested)
`decideTrend(closes, state, sources, params) -> { state, action: "hold" | "to-risk-off" | "to-risk-on", reason }`.
Persisted in `journal/trend-state.json` (atomic write; unreadable file = no decision, alert), as #55.

### 4.3 Peg checks (R90-3)
- **Before a switch into sBTC:** the pool's implied sBTC price within 3% of BTC/USD. A larger gap means
  a broken sBTC peg, not a cheap entry.
- **Before a switch into USDCx:** USDCx/USD from the reference within 1% of $1.
- Both are disclosed: risk-off is 100% exposure to a bridged stablecoin's issuer and bridge; risk-on
  holds sBTC, exposure to its peg.

### 4.4 Execution and exit capacity (R90-1)
The exit has to run in the market the rule exists for: falling, with a thin pool. On 2026-11-14,
four of five rebalance swaps aborted (`u2003`, minimum received).
- Swaps through the sBTC/USDCx HODLMM pool, reusing the DLMM swap path: deny-mode post-conditions,
  KILL re-checked before every broadcast (#58), nonce gate.
- **Min-outs floored by the reference price** (as #67 does for XYK), not only the pool's own quote,
  which is the number most likely to be off in a thin, falling pool.
- **Part-switched policy.** A switch that cannot finish is saved as a pending switch and resumed each
  cycle with **halving chunks** (from $600 down to a $50 floor). The min-out stays at 1% from the
  reference. A risk-off switch that is still part-done after two cycles alerts a human; it never
  widens the min-out on its own.
- **Exit capacity is measured, not assumed.** Observe mode logs every day how much sBTC the pool would
  have taken at the 1% min-out. The simulation's flat 0.5% switch cost gets a second version that
  includes failed and partial exits from those logs.
- **Unpredictable timing (R90-6).** The decision is taken at a random minute within the decision hour,
  and a large switch is split across cycles, so a thin pool cannot be front-run on a known schedule.

### 4.5 What happens to the current positions
- **DLMM sBTC/USDCx**: withdrawn when the mode goes live. Its capital becomes the 30/70 (or 100%
  USDCx) holding. No automatic re-opening.
- **XYK sBTC/STX**: out of scope for v1. Its STX exposure is not protected and the dashboard says so.
- **Liquidity sleeve (later, optional)**: at most 20% of capital, only while risk-on, range ±50,
  withdrawn on every switch to risk-off, and only after the core has run for a month.

### 4.6 Limits
- At most 6 switches per 30 days; exceeding it halts the mode and alerts (bad data or an extreme market).
- Existing gates still apply: safety verdict, drawdown (#64, in USD with #97), circuit breaker, KILL.
- Sizes come only from this mode's reserved balance (section 3.1).

### 4.7 Settings
`TREND_MODE=observe|live` (default observe), `TREND_SMA_DAYS=60`, `TREND_BUFFER=0.02`,
`TREND_RISK_SHARE=0.3`, `TREND_MAX_SWITCHES_30D=6`, `TREND_DECISION_UTC_HOUR=0` (minute randomised).

### 4.8 Reporting
- Dashboard: current state, close vs SMA60 and the distance to each switch line, the daily exit
  capacity, the switch log with transaction ids, and performance against two benchmarks: holding
  30/70 and 100% USDCx.
- Journal entry every day, including no-decision days and why.

## 5. Decided (review answers, 2026-11-17)
1. **Risk share:** 30% in v1 (section 2).
2. **Idle USDCx:** held, not lent. About 1.6% does not pay for Zest's contract risk, and a stressed
   lender can delay the withdrawal exactly when the rule wants to switch back to risk-on.
3. **STX:** not covered in v1. It has its own trend and a thinner pool, and the rule was not tested on it.
4. **Intraday emergency exit:** not in v1 (R90-7). It would need its own pre-registration and adds
   the same exit risk as R90-1.
5. **Vault v3:** update the v3 note after v1 has run. For third-party money this is discretionary
   management, so it needs a legal check first (R90-4). In v3 a switch moves up to half the vault
   through one pool, so the rebalance protections for the vault (tight Pyth publish-time bounds,
   active-bin distance) apply to switches too; one oracle design should serve both.

## 6. Rollout
1. Prerequisites: #67 merged; per-venue reservation (section 3.1) built and tested.
2. Build behind `TREND_MODE=observe`: the agent logs what it would do each day, and the exit capacity
   it would have had; nothing is sent. Tests: the state machine, the asymmetric source rules, the peg
   checks, and the part-switched path through the fault harness.
3. Observe for at least 14 days, ideally through at least one fall; compare the logged decisions with
   an independent recomputation.
4. Public note before going live (README, dashboard): the strategy change, what it does, the upside it
   gives up, the stablecoin and peg exposures, and that the XYK position is not covered. The README and
   dashboard today present HODLMM liquidity as the product, so those claims change too (R90-4).
5. Go live with the owner's capital, attended for the first switch.

## 7. Reproducing the evidence
`research/trend-rule/`: `PREREGISTERED.md` and `PREREGISTERED_VOL.md` (written before any result),
`validate.py` and `validate_vol.py` (as pre-registered), `revalidate.py` (the post-review re-run),
`fetch.sh` (the data), and `dlmm_sim.py` (the concentrated-liquidity simulation).
