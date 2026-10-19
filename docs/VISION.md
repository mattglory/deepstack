# DeepStack — Vision

> **Autonomous liquidity infrastructure for Bitcoin DeFi.**
> An AI-tuned, safety-first market-making agent providing active liquidity across venues,
> uniquely composable with FlashStack's atomic flash-loans, and built toward a trust-minimised
> vault — with reach extending from AMM liquidity today to concentrated liquidity,
> order-book/perps quoting, and multichain as those venues mature.
> Stacks now has first-party keepers (Bitflow) and independent AI market-making agents
> (aibtcdev / K9Dreamer); DeepStack's edge is the flash-composability, the fail-closed
> safety layer, and cross-venue independence none of them combine. See [COMPETITIVE.md](COMPETITIVE.md).
>
> *(Updated 2026-07-23 with newly verified information — see the whitepaper's revision note.
> Scope unchanged; claims staged more precisely as shipped / roadmap / gated.)*
> *(Updated 2026-10-19: concentrated liquidity is live on Stacks and DeepStack runs a position
> on it; vault status and the custody gap to the Steer model are stated below.)*

## The problem

Stacks holds ~**$545M of sBTC**, yet on-chain trading depth is thin and concentrated in
a few venues. Automated liquidity now exists — Bitflow's HODLMM Keepers (auto-rebalancing
concentrated-LP, live Mar 2026) and independent AI agents on the aibtcdev network (K9Dreamer
et al.) market-making HODLMM with public receipts. What none of them combine is what Bitcoin
DeFi still lacks: an operator that pairs **atomic flash-composable rebalancing (FlashStack)**
with a **fail-closed safety architecture** and genuine **cross-venue/multichain independence**,
built toward a **trust-minimised vault** — and that extends into order-book/perps quoting
(gated today on venue security — the Velar exploit) as safe venues mature. Depth is the
bottleneck; DeepStack's job is to supply it safely, composably, and where no one else is.

## What DeepStack is

An **agentic liquidity manager**: a deterministic execution core (ported from a live
Dexalot market-making bot) with an off-the-hot-path AI tuning layer (OpenRouter).
It reads on-chain state, decides allocation + rebalancing, and acts — today on the
Bitflow sBTC-STX pool and a concentrated (DLMM) position on Bitflow HODLMM's sBTC/USDCx pool,
both validated with live mainnet transactions.

Same category as **Steer Finance, Gamma Strategies, Arrakis** — automated, AI-assisted
liquidity management — but **Bitcoin-native**, settling in sBTC via Clarity.

## How it makes money (honestly)

Rebalancing *pays* fees; income comes from three fee-backed paths, net of impermanent
loss — never from token emissions or "guaranteed high yield":

1. **LP fee income** — provide liquidity, earn a share of the pool's 0.5% trading fee.
2. **Liquidity-mining incentives** — protocol/venue token rewards (where available).
3. **Spread / arbitrage** — cross-venue arbitrage today, and order-book quoting on Velar
   perps (the classical MM edge) once the venue's post-exploit remediation is verified —
   a gated roadmap path, not current income.

**The scalable model (the Steer insight):** beyond running its own capital, DeepStack
manages *others'* liquidity through **trust-minimised vaults** and earns a management +
performance fee on AUM. That is how an ALM scales — fees on deposited capital, not on
a single operator's balance.

## Roadmap

| Stage | What | Status |
|---|---|---|
| **1. Solo agent** | One agent, one pool, AI-tuned, mainnet-validated | ✅ live |
| **2. Multi-pool** | Several sBTC pairs; concentrated-liquidity (DLMM) adapter; arbitrage; **Velar perps quoting (gated on re-audit)** | DLMM adapter ✅ live on mainnet; Velar still gated |
| **3a. Vault v2** | Deposit vault with shares, epochs, a performance fee over a high-water mark, timelocked 2-of-3 admin | tested on testnet; mainnet with the owner's own capital next. **Custodial while deployed** (see below) |
| **3b. Vault v3** | Trust-minimised: the vault contract itself owns the position; others deposit; fee on AUM | design stage ([VAULT_V3_DESIGN_NOTE.md](VAULT_V3_DESIGN_NOTE.md)) |
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

### Where DeepStack stands against that model (2026-10-19)

| Steer-style piece | DeepStack today |
|---|---|
| Deposit vault with shares and a fee on gains | Vault v2 built and tested on testnet |
| Concentrated-liquidity management | Live on mainnet (Bitflow HODLMM sBTC/USDCx) |
| Fail-closed safety | Oracle checks, kill switch, drawdown block, deploy cap, timelocks, 2-of-3 admin |
| **Funds stay in the vault contract while managed** | **Not yet.** In v2, up to 50% of assets is sent to a strategy wallet and must be returned; the contract bounds the loss (cap, epoch deadline, write-off, drawdown block) but cannot force the return. That is custodial in practice, and v2 is not offered to outside depositors |
| Third-party strategies, decentralised keepers, "powered by" | Not yet: one in-house strategy and one operator |
| Track record and professional audit | Short pilot, small capital, no professional audit yet |

Closing the custody gap is the v3 goal: the vault holds the position itself and the agent can
only instruct it within limits the contract enforces.

## Why only on Stacks

Bitcoin-native AMM liquidity to make markets on exists only here (sBTC + Clarity +
Proof of Transfer). Stacks now has a concentrated-liquidity DEX (Bitflow HODLMM, live since
March 2026), and DeepStack already manages a live position on it, so the Steer-style model
applies today. The remaining step is a vault that owns its position rather than handing
capital to an operator.

## Honest positioning

- **Today:** an autonomous liquidity agent for Stacks — proven on mainnet, open source; a
  deposit vault (v2) tested on testnet, not yet open to outside depositors.
- **Direction:** the ALM infrastructure layer for Bitcoin DeFi — *building* what Steer
  is for EVM, for the chain it doesn't cover.

We are not claiming to *be* Steer, nor to be the only automated-liquidity agent on Stacks —
first-party keepers and independent AI market-makers already exist and do good work. We are
building the **flash-composable, safety-first, cross-venue** version heading toward a vault —
the combination none of them offer — for a market with $545M of idle sBTC and depth that is
still measurably thin. That gap is real, and it is the one DeepStack is built to close.
