# DeepStack — Competitive Landscape & Differentiation

*Last updated: 2026-06-30. Honest assessment of who occupies the automated-liquidity
space on Stacks and where DeepStack is actually different.*

## TL;DR

DeepStack is **not the first** automated-liquidity project on Stacks — the category
filled up in 2026. But the existing players are **first-party LP keepers** (Bitflow)
and **yield-routing agents** (AIBTC). None do **independent, AI-tuned, order-book
market-making** — especially **Velar perps quoting** — which is DeepStack's edge.

## The landscape

| | **Bitflow Keepers** | **AIBTC** | **DeepStack** |
|---|---|---|---|
| Launched | HODLMM live Mar 2026 | 2026, active | PoC + mainnet-validated 2026 |
| Core focus | Concentrated-LP position mgmt | Yield routing + agent framework | Active market-making |
| AMM LP rebalance/harvest | ✅ first-party, 24/7 | — | ✅ (don't compete here) |
| Idle-yield routing (Zest/HODLMM) | — | ✅ | ✅ (don't compete here) |
| **Order-book MM (Velar perps)** | ❌ | ❌ | ✅ **core edge** |
| **Independent / cross-venue** | ❌ Bitflow-only | partial | ✅ |
| **AI-tuned strategy** | ❌ no AI | ✅ different focus | ✅ |
| Third-party / open-source | ❌ first-party | partial | ✅ MIT |
| Flash-loan flash-rebalance | ❌ | ❌ | ✅ (via FlashStack) |

## What each one is

**Bitflow HODLMM + Keepers** (live since Mar 4 2026). Concentrated-liquidity engine
(sBTC/STX/USDCx) with first-party "Keepers" that auto-rebalance, harvest fees, and
optimize LP positions 24/7. Closest overlap — but it is **first-party** (no external
strategy builders), **single-venue** (Bitflow's own pools), and uses **no AI**.

**AIBTC.** Bitcoin-native AI-agent framework (MCP server, BTC/STX wallets) including an
autonomous sBTC **yield daemon** that routes idle sBTC to the best yield (compares Zest
vs Bitflow HODLMM APR). Overlaps DeepStack's idle-yield scan — but its focus is
**passive yield + DAO/agent tooling**, not active market-making.

## DeepStack's differentiation (where we don't overlap)

1. **Order-book market-making on Velar perps.** Two-sided quoting, inventory, and
   hedging — the discipline ported from a live Dexalot (Avalanche) MM bot. Neither
   Keepers (AMM LP) nor AIBTC (yield) addresses this. **This is the moat.**
2. **Independent and cross-venue.** Not tied to one DEX's first-party automation; can
   operate across Bitflow, ALEX, and Velar, and route to the best venue.
3. **AI-tuned, off the hot path.** OpenRouter classifies regime and tunes parameters on
   a cadence; the deterministic core executes. Explainable, not a black box.
4. **Composability with FlashStack** (live, all 3 milestones delivered): flash-loan-
   powered capital-efficient rebalancing — a primitive only this builder has.
5. **Open source (MIT).** A reusable Stacks MM adapter others can build on, vs closed
   first-party tooling.

## Honest positioning

- We **complement** the ecosystem rather than fight it: Bitflow Keepers handle
  passive concentrated-LP; AIBTC handles yield routing; **DeepStack handles active
  market-making and perps quoting** — the part neither does.
- We do **not** claim "no ALM on Stacks." We claim "no **independent, AI-driven,
  perps/cross-venue** market-maker on Stacks" — which is accurate.
- The existence of Bitflow Keepers and AIBTC **validates the category**: serious teams
  are building automated liquidity on Stacks. DeepStack occupies the MM/perps niche.

## Risks this creates (and mitigations)

- **Bitflow could extend Keepers to perps / add AI** → mitigated by speed, independence,
  cross-venue reach, and the open-source community angle.
- **DeepStack's AMM-LP rebalancing overlaps Keepers** → don't position there; lead with
  perps MM and cross-venue routing.
- **AIBTC's yield daemon overlaps the yield scan** → keep the yield module as a utility,
  not the headline; the headline is market-making.
