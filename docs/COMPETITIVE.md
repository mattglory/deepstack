# DeepStack — Competitive Landscape & Differentiation

*Last updated: 2026-11-01 (first written 2026-07-23). An honest assessment of who occupies the automated-liquidity
space on Stacks and where DeepStack is genuinely different. In keeping with the project's
"audit me" principle, this doc states only claims that are verifiable on-chain or in the
open-source code, and is honest about where others are ahead.*

## TL;DR

DeepStack is **not the first and not the only** autonomous-liquidity project on Stacks —
the category is real and getting good. Bitflow runs first-party concentrated-liquidity
Keepers; independent AI agents on the **aibtcdev** network (notably **K9Dreamer**) now
market-make Bitflow HODLMM pools in public with on-chain receipts. DeepStack's distinct
ground is **an explicit fail-closed safety architecture, honest accounting measured from chain
data, and cross-venue independence**, with a trust-minimised vault as the end goal. Flash-loan
rebalancing through FlashStack was demonstrated on-chain during the pilot, but the autonomous
route has been paused since October 2026 (see [FLASH_REBALANCE.md](FLASH_REBALANCE.md)), so it
is not a current differentiator. Transparency is no longer a differentiator on its own; it is now table stakes, and
that is a good thing for the ecosystem.

## The landscape

| | **Bitflow Keepers** | **aibtcdev agents (e.g. K9Dreamer)** | **DeepStack** |
|---|---|---|---|
| Status | HODLMM Keepers live Mar 2026 | Live; K9Dreamer has a 6-week public MM track record (Jul 2026) | Live on mainnet since Jul 2026; 30-day public pilot closed Sep 2026 |
| Core focus | First-party concentrated-LP mgmt | Autonomous AI MM on HODLMM + open agent guides | Independent AI MM, safety-first, heading to a trust-minimised vault |
| Concentrated-liquidity MM | ✅ first-party | ✅ live | ✅ live (HODLMM sBTC/USDCx since Aug 2026) |
| AI-driven | ❌ | ✅ | ✅ (advisory; deterministic core executes) |
| Public on-chain receipts | — | ✅ | ✅ (live dashboard, fees net of IL, fees measured from the bins on chain) |
| Fail-closed safety layer | partial (first-party) | ✅ agent-level halts/caps | ✅ oracle, drawdown and paused-pool gates, exact on-chain caps, kill switch |
| Flash-loan atomic rebalance | ❌ | ❌ | ⏸ demonstrated on-chain in the pilot; autonomous route paused since Oct 2026 |
| Independent / cross-venue | ❌ Bitflow-only | aibtcdev/Bitflow-centric | ✅ two venue types today; other chains are a direction, not shipped |
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

1. **An explicit fail-closed safety architecture — shipped.** A deterministic core makes every
   capital decision; the AI layer only advises and tunes parameters off the hot path and can
   only *tighten* risk, never loosen it. An oracle-sanity gate halts on price divergence, a
   paused pool, or a missing external reference (fail-closed), plus an exit-liquidity cap and a
   regime-aware defensive reflex. All verifiable in the MIT-licensed code.
2. **Honest accounting, measured from chain data — shipped.** Results are reported as fees net
   of impermanent loss against simply holding, and since November 2026 the concentrated
   position's fees are measured directly from its bins on chain rather than estimated from
   pool-wide averages (which overstated them about fourfold on the day we checked).
3. **Independent and cross-venue by design — partly shipped, partly roadmap.** DeepStack is not
   tied to one venue's first-party automation or one agent network. The multichain thesis
   (other Bitcoin L2s) is a declared direction, not a shipped fact.
4. **A trust-minimised vault as the end goal — roadmap.** Vault v2 (epoch-based, 2-of-3
   multisig admin) is fully tested on testnet; v3, in which the vault owns its position and the
   agent can manage but never withdraw, is at design stage. The endgame is managing *others'*
   capital under a safety mandate (yield in calm markets, capital preservation when risk
   spikes), not only running the project's own book. This is a stated goal, not a live product. The Phase 1 vault deployed in October 2026 is
   custodial in practice (its admin can move deployed capital), so it was paused and wound down.
5. **FlashStack composability — demonstrated, currently paused.** DeepStack executed an atomic
   flash-rebalance on-chain during the pilot (borrow, rebalance, repay in one transaction). The
   autonomous route was paused in October 2026 because the deployed receiver repays from the
   agent's own STX and so adds no capacity; it returns only with a receiver that does
   ([FLASH_REBALANCE.md](FLASH_REBALANCE.md)). We do not lead with it until then.

## Honest positioning

- **Transparency is shared ground now, not a moat.** The aibtcdev agents publish receipts too,
  and that raises the whole ecosystem's bar. DeepStack keeps the same discipline (losses shown
  as openly as gains) because it's right — not because it's unique.
- **We do not claim to be first, alone, or ahead everywhere.** On live concentrated-liquidity
  execution, others are ahead today. DeepStack's claim is narrower and defensible: *the
  safety-first, cross-venue liquidity layer, heading toward a trust-minimised vault.*
- **The category filling up validates it.** Bitflow Keepers and the aibtcdev agents prove
  serious builders see the same opportunity. DeepStack competes on an explicit safety architecture,
  measured accounting and the path to a trust-minimised vault, not on out-branding work that's
  already good.

## Risks this creates (and honest mitigations)

- **The aibtcdev agents have a head start on HODLMM MM and Bitflow adjacency.** Mitigation:
  don't fight head-on to be "the honest HODLMM MM": lead with the safety layer and the vault
  path, and expand to venues/chains where no agent is entrenched.
- **Bitflow could extend Keepers, or the agent networks could add flash-composability.**
  Mitigation: keep executing the safety and vault work, bring the flash route back only once it
  adds real capacity, and stay genuinely cross-venue.
- **Concentrated-liquidity results are still short.** The position has run since August 2026
  with real capital only since late October. Mitigation: publish the measured fees and the
  result against holding as the record grows, including bad weeks.

## Composition, not only competition

The aibtcdev guides ecosystem is *open*. Once FlashStack's rebalance route adds real capacity,
its atomic-rebalance rails could be infrastructure that other agents — including competitors — compose with, rather than only a
feature DeepStack keeps to itself. Being the flash-loan layer the agent economy builds on is a
stronger long-term position than winning a brand fight. That path is worth pursuing in parallel.
