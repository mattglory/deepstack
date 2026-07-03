# DeepStack — Vision

> **The independent, AI-driven market-making layer for Bitcoin DeFi.**
> Stacks now has first-party LP keepers (Bitflow) and yield-routing agents (AIBTC) —
> but no independent, AI-tuned, cross-venue market-maker, especially for perps.
> That is the niche DeepStack fills. See [COMPETITIVE.md](COMPETITIVE.md).

## The problem

Stacks holds ~**$545M of sBTC**, yet on-chain trading depth is thin and concentrated in
a few venues. First-party tooling now exists for *passive* liquidity — Bitflow's HODLMM
Keepers (auto-rebalancing concentrated-LP, live Mar 2026) and AIBTC's yield daemon
(idle-sBTC routing) — but there is **no independent, AI-driven *active* market-maker**,
and **no order-book market-making for perps** (Velar). Bitcoin DeFi still lacks operators
with real market-making experience deploying it as cross-venue, open infrastructure.

## What DeepStack is

An **agentic liquidity manager**: a deterministic execution core (ported from a live
Dexalot market-making bot) with an off-the-hot-path AI tuning layer (OpenRouter).
It reads on-chain state, decides allocation + rebalancing, and acts — today on the
Bitflow sBTC-STX pool, validated with live mainnet transactions.

Same category as **Steer Finance, Gamma Strategies, Arrakis** — automated, AI-assisted
liquidity management — but **Bitcoin-native**, settling in sBTC via Clarity.

## How it makes money (honestly)

Rebalancing *pays* fees; income comes from three fee-backed paths, net of impermanent
loss — never from token emissions or "guaranteed high yield":

1. **LP fee income** — provide liquidity, earn a share of the pool's 0.5% trading fee.
2. **Liquidity-mining incentives** — protocol/venue token rewards (where available).
3. **Spread / arbitrage** — quoting on Velar perps (the order-book MM edge) and
   cross-venue arbitrage.

**The scalable model (the Steer insight):** beyond running its own capital, DeepStack
manages *others'* liquidity through **non-custodial vaults** and earns a management +
performance fee on AUM. That is how an ALM scales — fees on deposited capital, not on
a single operator's balance.

## Roadmap

| Stage | What | Status |
|---|---|---|
| **1. Solo agent** | One agent, one pool, AI-tuned, mainnet-validated | ✅ live |
| **2. Multi-pool** | Several sBTC pairs; Velar perps quoting; arbitrage | next |
| **3. Vaults** | Non-custodial Clarity vaults others deposit into; fee on AUM | the revenue model |
| **4. Infrastructure** | White-label ALM for Stacks protocols bootstrapping liquidity | the platform |

## The Steer model, precisely (what their live playbook teaches)

Steer's homepage says "vaults." Their actual behaviour on-chain and on X is sharper and
**two-sided** — and it's the shape DeepStack should grow into:

1. **User-deposit vaults ("Smart Pools").** Anyone deposits; the protocol manages the
   position and harvests fees; depositors earn, the protocol takes a fee on AUM. This is
   DeepStack's Stage 3 — the multi-user, scalable revenue model.
2. **"Powered by" white-label.** DEXs embed Steer as their liquidity-management engine and
   offer it to *their own* users ("*you don't need to manage liquidity — [DEX] can do it
   for you, powered by Steer*"). Steer doesn't compete with the venue; it **powers** it.

The lesson for DeepStack: the durable win is being **infrastructure other venues embed**,
not a standalone competitor. Concretely, this reframes venue BD:

- Venues that already have first-party ALM (Bitflow HODLMM Keepers) → complement, don't
  compete: offer what their keeper doesn't (perps quoting, cross-venue routing) or just
  be an independent LP.
- Venues **without** their own ALM (Velar, ALEX2, newer/smaller Stacks DEXs) → the
  "powered by DeepStack" pitch fits: be the liquidity engine they embed.

Caveat: both the vault and white-label models require an **audited, multi-tenant** product
— a direction anchor for after the pilot, not a near-term build. Steer is a mature, funded,
multi-chain team; this is the shape to grow toward, not a race to match today.

## Why only on Stacks

Bitcoin-native AMM liquidity to make markets on exists only here (sBTC + Clarity +
Proof of Transfer). When Stacks gains concentrated-liquidity DEXs, the full Steer-style
vault model applies directly — and DeepStack will be the ALM already in place.

## Honest positioning

- **Today:** an autonomous liquidity agent for Stacks — proven on mainnet, open source.
- **Direction:** the ALM infrastructure layer for Bitcoin DeFi — *building* what Steer
  is for EVM, for the chain it doesn't cover.

We are not claiming to *be* Steer. We are building it for Bitcoin — and the whitespace
(no independent / cross-venue ALM on Stacks, $545M idle sBTC) is real and measurable.
