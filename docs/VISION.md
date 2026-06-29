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

## Why only on Stacks

Bitcoin-native AMM liquidity to make markets on exists only here (sBTC + Clarity +
Proof of Transfer). When Stacks gains concentrated-liquidity DEXs, the full Steer-style
vault model applies directly — and DeepStack will be the ALM already in place.

## Honest positioning

- **Today:** an autonomous liquidity agent for Stacks — proven on mainnet, open source.
- **Direction:** the ALM infrastructure layer for Bitcoin DeFi — *building* what Steer
  is for EVM, for the chain it doesn't cover.

We are not claiming to *be* Steer. We are building it for Bitcoin — and the whitespace
(no ALM on Stacks, $545M idle sBTC) is real and measurable.
