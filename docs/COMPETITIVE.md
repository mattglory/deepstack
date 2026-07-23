# DeepStack — Competitive Landscape & Differentiation

*Last updated: 2026-07-23. An honest assessment of who occupies the automated-liquidity
space on Stacks and where DeepStack is genuinely different. In keeping with the project's
"audit me" principle, this doc states only claims that are verifiable on-chain or in the
open-source code, and is honest about where others are ahead.*

## TL;DR

DeepStack is **not the first and not the only** autonomous-liquidity project on Stacks —
the category is real and getting good. Bitflow runs first-party concentrated-liquidity
Keepers; independent AI agents on the **aibtcdev** network (notably **K9Dreamer**) now
market-make Bitflow HODLMM pools in public with on-chain receipts. DeepStack's distinct
ground is **flash-loan-composable rebalancing (FlashStack), an explicit fail-closed safety
architecture, and cross-venue/multichain independence** — with a non-custodial vault as the
end goal. Transparency is no longer a differentiator on its own; it is now table stakes, and
that is a good thing for the ecosystem.

## The landscape

| | **Bitflow Keepers** | **aibtcdev agents (e.g. K9Dreamer)** | **DeepStack** |
|---|---|---|---|
| Status | HODLMM Keepers live Mar 2026 | Live; K9Dreamer has a 6-week public MM track record (Jul 2026) | FlashStack live + sBTC-STX pilot live 2026 |
| Core focus | First-party concentrated-LP mgmt | Autonomous AI MM on HODLMM + open agent guides | Independent AI MM, flash-composable, safety-first |
| Concentrated-liquidity MM | ✅ first-party | ✅ **live today** | 🔜 roadmap adapter (pilot is XYK now) |
| AI-driven | ❌ | ✅ | ✅ (advisory; deterministic core executes) |
| Public on-chain receipts | — | ✅ | ✅ (live dashboard, fees net of IL) |
| Fail-closed safety layer | partial (first-party) | ✅ agent-level halts/caps | ✅ explicit oracle-halt + regime-aware reflex |
| Flash-loan atomic rebalance | ❌ | ❌ | ✅ **FlashStack — proven on-chain** |
| Independent / cross-venue | ❌ Bitflow-only | aibtcdev/Bitflow-centric | ✅ multichain thesis |
| Open source | ❌ first-party | partial (open guides) | ✅ MIT |

## What each one is

**Bitflow HODLMM + Keepers** (live since Mar 4 2026). A concentrated-liquidity engine
(sBTC/STX/USDCx) with first-party "Keepers" that auto-rebalance, harvest fees, and manage
LP positions 24/7. It is **first-party** (Bitflow's own pools and automation) and uses no AI.

**Independent AI agents on aibtcdev — K9Dreamer is the clearest example.** An autonomous
agent (Claude in a self-editing loop, self-custodied Stacks wallet via aibtcdev MCP tooling,
Bitflow HODLMM CLI, cron) that market-makes concentrated-liquidity pools and publishes honest
closeouts — PnL vs. hold, every transaction hash, its own mistakes and self-corrections. This
is genuine, well-executed work, and it is the **closest thing to DeepStack that exists.** It
is ahead of DeepStack on one thing specifically: **live concentrated-liquidity execution with
a public track record.** We say so plainly.

## Where DeepStack is genuinely different

Stated honestly — some of these are shipped and verifiable today, some are the declared
roadmap, and each is labelled as such.

1. **FlashStack composability — shipped and proven.** DeepStack runs alongside FlashStack, a
   flash-loan protocol live on mainnet (STX + sBTC cores, all three grant milestones
   delivered). DeepStack has executed an **atomic flash-rebalance on-chain** — borrow,
   rebalance, and repay in a single transaction — which removes the multi-step "exit →
   reposition → re-enter" round-trip that costs gas and realizes loss at every hop. No other
   liquidity agent on Stacks has a flash-loan protocol. *Honest caveat: FlashStack's reserves
   are still small (bootstrapping) — it is the atomic **rails and the proven pattern** that
   are the edge today, not deep available capital.*
2. **An explicit fail-closed safety architecture — shipped.** A deterministic core makes every
   capital decision; the AI layer only advises and tunes parameters off the hot path and can
   only *tighten* risk, never loosen it. An oracle-sanity gate halts on price divergence, a
   paused pool, or a missing external reference (fail-closed), plus an exit-liquidity cap and a
   regime-aware defensive reflex. All verifiable in the MIT-licensed code.
3. **Independent and cross-venue by design — partly shipped, partly roadmap.** DeepStack is not
   tied to one venue's first-party automation or one agent network. The multichain thesis
   (other Bitcoin L2s) is a declared direction, not a shipped fact.
4. **A non-custodial vault as the end goal — roadmap.** The endgame is managing *others'*
   capital under a safety mandate (yield in calm markets, capital preservation when risk
   spikes), not only running the project's own book. This is a stated goal, not a live product.

## Honest positioning

- **Transparency is shared ground now, not a moat.** The aibtcdev agents publish receipts too,
  and that raises the whole ecosystem's bar. DeepStack keeps the same discipline (losses shown
  as openly as gains) because it's right — not because it's unique.
- **We do not claim to be first, alone, or ahead everywhere.** On live concentrated-liquidity
  execution, others are ahead today. DeepStack's claim is narrower and defensible: *the
  flash-composable, safety-first, cross-venue liquidity layer, heading toward a vault.*
- **The category filling up validates it.** Bitflow Keepers and the aibtcdev agents prove
  serious builders see the same opportunity. DeepStack competes on capabilities the others
  don't have (atomic flash-rebalance, an explicit safety architecture) and on reach (cross-
  venue / multichain), not on out-branding work that's already good.

## Risks this creates (and honest mitigations)

- **The aibtcdev agents have a head start on HODLMM MM and Bitflow adjacency.** Mitigation:
  don't fight head-on to be "the honest HODLMM MM" — lead with FlashStack composability and the
  safety layer, and expand to venues/chains where no agent is entrenched.
- **Bitflow could extend Keepers, or the agent networks could add flash-composability.**
  Mitigation: keep executing the FlashStack integration (a real head start) and the safety/
  vault work, and stay genuinely cross-venue.
- **DeepStack's concentrated-liquidity adapter is not shipped yet.** Mitigation: the pilot on
  sBTC-STX proves the mechanism and the safety layer honestly first; the concentrated-liquidity
  adapter is the declared next build, not a claim made before it exists.

## Composition, not only competition

The aibtcdev guides ecosystem is *open*. FlashStack's atomic-rebalance rails could be
infrastructure that other agents — including competitors — compose with, rather than only a
feature DeepStack keeps to itself. Being the flash-loan layer the agent economy builds on is a
stronger long-term position than winning a brand fight. That path is worth pursuing in parallel.
