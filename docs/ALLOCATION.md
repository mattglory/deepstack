# Regime-aware defensive allocation — the capital-preservation reflex

*Why DeepStack is more than a passive LP: it gets defensive when the market turns. This is
the feature that turns "a liquidity bot" into "the operator you trust with capital in a
bear market." Built, tested, and gated OFF by default — see "Pilot safety" below.*

## The problem with a static 50/50

A fixed 50/50 target is *inventory-neutral*: equal exposure to both assets, so P&L comes
from fees, not from a price bet. Correct for a market maker with no view — but it has no
reflexes. It holds half of a crashing asset all the way down. That is exactly what passive
LPs and naive vaults do, and it's why people lose money providing liquidity in a downturn.

Winning market makers don't hold a static split. The canonical model (Avellaneda-Stoikov)
skews the target and quotes with **inventory, volatility, and risk aversion**. DeepStack's
defensive allocation is that skew, made deterministic and bounded.

## The policy (`src/m1/allocation.ts`)

A risk signal is measured every tuning cycle from **realised volatility** and **portfolio
drawdown** (distance below the high-water mark). It maps to three regimes:

| Regime | Trigger | Inventory target | LP exposure | Rationale |
|---|---|---|---|---|
| **calm** | low vol, no drawdown | neutral 50/50 | full | make fees, no view |
| **elevated** | vol ≥ `VOL_ELEVATED` (4%/day) | neutral 50/50 | **halved** | cut impermanent-loss exposure in chop |
| **defensive** | vol ≥ `VOL_DEFENSIVE` (6%/day) **or** drawdown ≥ `DRAWDOWN_DEFENSIVE` (8%) | **skew to safe asset** (`DEFENSIVE_Y_FRACTION`) | **off** | preserve capital, hold the harder money, no IL |

### The safe asset is a stablecoin (USDCx) — sBTC is only the interim proxy

The *true* safe asset for capital preservation is a **stablecoin — USDCx** — because it holds
its value in a bear market. sBTC is still Bitcoin; it falls in a crash. So the full reflex is
to rotate **into USDCx**, and that is the intended destination.

The catch: the current pilot pair is **sBTC-STX, which has no USDCx leg**, and there's no
liquid USDCx pool to rotate into yet (~$80–150k of thin dlmm pools, no STX-USDCx pool). So
today the only defensive move *available within the pair* is an **interim** one: skew toward
the relatively harder asset (sBTC falls less than the STX alt) and pull LP to avoid IL. The
defensive target `y=0.35` means *less STX, more sBTC* — a placeholder, not the real thing.

### Haven rotation — BUILT, armed, and dormant (`src/m1/haven.ts`)

The full reflex is built: in a defensive regime, rotate a portion of the portfolio (default
40%) OUT of the volatile pair and INTO USDCx. The decision logic and route-readiness detection
run **every cycle** and are journalled (`type:"haven"`), so the record shows exactly what the
agent would do and whether it can.

**But execution is DORMANT, honestly so.** A "route" is a USDCx pool deep enough
(≥ `HAVEN_MIN_LIQ_USD`, default $250k) that rotating in won't slip catastrophically. No such
pool exists today — USDCx DEX pools are ~$80–150k dust. So each cycle the agent journals
`"armed: want 40% USDCx but deepest pool is $Xk < $250k min — dormant"`. It never routes into
dust (protection that fails when needed is worse than none). The moment a real USDCx pool
launches, `havenRouteReady` flips to ready and a configured `HavenRoute` activates the same
logic — no rewrite. The cross-pool scanner already feeds it the pool data that trips the switch.

Config: `HAVEN_ASSET`, `HAVEN_DEFENSIVE_FRACTION` (0.4), `HAVEN_ELEVATED_FRACTION` (0.15),
`HAVEN_MIN_LIQ_USD` (250000).

## Where the AI fits (and its hard limit)

The AI tuning layer classifies the regime in words; DeepStack maps risk-off language
("volatile", "stressed", "bearish") to a defensive lean. **Crucially, the AI can only
TIGHTEN risk, never loosen it** — advice may make the agent more cautious, never less.
Measured vol + drawdown are the deterministic floor the model cannot override downward.
This is the same principle as everywhere in DeepStack: *the AI advises, the deterministic
core decides, risk controls only tighten on advice.* An LLM can never move capital or
relax a guardrail.

## Pilot safety — OFF by default

`ALLOCATION_MODE` defaults to `static`: `decideAllocation` returns exactly neutral 50/50
with full LP, so **the 30-day pilot runs the strategy pre-declared in PILOT_METHODOLOGY.md,
unchanged.** Adaptive allocation is a deliberate, separate activation (`ALLOCATION_MODE=
adaptive`) intended for post-pilot, or as a declared strategy change with Endowment
awareness — never a silent mid-pilot shift. Every regime decision is journalled
(`allocation` field on each tune entry) whether static or adaptive.

## Config

```ini
ALLOCATION_MODE=adaptive        # default "static" — leave off during the declared pilot
DEFENSIVE_Y_FRACTION=0.35       # target Y in defensive mode (<0.5 skews toward x / sBTC)
VOL_ELEVATED=0.04               # sigma/day to trim LP
VOL_DEFENSIVE=0.06              # sigma/day to go fully defensive
DRAWDOWN_DEFENSIVE=0.08         # drawdown fraction that forces defensive regardless of vol
```

## Why this is the product

Depositors don't fear missing upside — they fear losing capital in a crash. A manager that
provides liquidity for yield in calm markets *and* pulls back to preserve capital when
risk spikes is offering something almost nothing else in DeFi does. This is the reflex that
makes DeepStack's future non-custodial vault worth depositing into: safe by construction,
defensive by design, and every decision auditable on-chain.
