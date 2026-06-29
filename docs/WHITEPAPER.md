# DeepStack: An Independent, AI-Tuned Market-Making Agent for Bitcoin DeFi on Stacks

**Author:** Matt Glory (Glory Matthew)
**Version:** 1.0 · **Date:** 2026-06-30
**Repository:** https://github.com/mattglory/deepstack ·
**Live dashboard:** https://dashboard-two-alpha-t9c0vbn07m.vercel.app

---

## Abstract

DeepStack is an autonomous, AI-tuned market-making and liquidity agent for Stacks,
the Bitcoin layer that settles to Bitcoin via Proof of Transfer and is home to sBTC,
a 1:1 Bitcoin-backed asset. Bitcoin DeFi has accumulated substantial sBTC capital but
historically lacked independent operators with professional market-making experience.
DeepStack pairs a deterministic execution core — ported from a live market-making bot
on Dexalot (Avalanche) — with an AI strategy layer (via OpenRouter) that is kept
strictly off the execution hot path. The agent reads on-chain state, decides liquidity
allocation and inventory rebalancing, and acts under hard safety constraints. The
system is not a paper design: its write path is validated by real Stacks mainnet
transactions, and every metric is published on a backend-free, independently verifiable
dashboard. This paper presents the motivation, architecture, safety model, economics,
competitive context, and roadmap, and is explicit about what DeepStack does and does
not yet do.

---

## 1. Introduction

Stacks brings smart contracts and DeFi to Bitcoin without modifying Bitcoin itself.
sBTC unlocks Bitcoin's capital into programmable on-chain finance — lending, trading,
and yield — while remaining redeemable 1:1 for BTC. As of Q1 2026, the Stacks ecosystem
held on the order of **$545M of sBTC**, but tradable on-chain depth lagged far behind:
the deepest BTC DEX pool measured by DeepStack's own proof-of-concept was approximately
**$619k**. That gap — large Bitcoin-backed capital, thin tradable depth — is the
opportunity DeepStack addresses.

Market-making is the standard mechanism for converting idle capital into usable depth.
It is also a discipline: quoting two-sided prices, managing inventory and risk, and
reacting to volatility. DeepStack brings that discipline to Bitcoin DeFi as an
**independent, open-source agent**, rather than first-party tooling tied to a single
venue.

> **Note on figures.** The $545M and $619k figures are as of early 2026. In March 2026,
> Bitflow launched HODLMM (concentrated liquidity) with professional market-maker
> commitments, materially improving depth on at least one venue. DeepStack treats live
> on-chain measurement — not static figures — as ground truth (see §8).

## 2. Background: market-making on an AMM

Most Stacks DEX liquidity has lived in **constant-product (XYK) AMMs** (`x · y = k`),
which spread liquidity across all prices and have no concentrated range. On such a pool
the market-making levers are:

1. **Liquidity provision** — deposit both assets to earn a share of trading fees.
2. **Inventory rebalancing** — swap to hold a target asset ratio and hedge drift.
3. **Regime response** — size up or withdraw as conditions change.

True two-sided **order-book quoting** — the classical market-making edge — is not
expressed on a full-range AMM; it belongs on an order-book or perpetuals venue. On
Stacks that venue is **Velar perps**. DeepStack therefore treats AMM pools as the
liquidity/inventory layer and reserves order-book quoting for perps.

## 3. Problem statement

1. **Idle Bitcoin capital.** Large sBTC balances earn little when not deployed into
   liquidity or yield.
2. **Thin, fragmented depth.** Wide spreads and slippage degrade execution and deter
   larger flows.
3. **Few professional operators.** Bitcoin DeFi has lacked independent agents that run
   real market-making with risk controls, transparently and verifiably.

## 4. Related work

DeepStack is part of the **automated liquidity management (ALM)** category that Steer,
Gamma, and Arrakis occupy across EVM chains. On Stacks specifically, two adjacent
efforts now exist:

- **Bitflow HODLMM + Keepers** (live March 2026): a concentrated-liquidity engine with
  first-party "Keepers" that auto-rebalance, harvest fees, and optimize LP positions
  24/7. It is first-party (Bitflow's own pools), single-venue, and uses no AI.
- **AIBTC**: a Bitcoin-native AI-agent framework with an autonomous sBTC *yield daemon*
  that routes idle sBTC to the best yield (comparing lending vs HODLMM APR). Its focus
  is passive yield routing and agent tooling, not active market-making.

DeepStack does **not** claim to be the first automated-liquidity project on Stacks.
Its differentiation is being **independent, cross-venue, AI-tuned, and focused on active
market-making — especially Velar perps order-book quoting** — which neither first-party
keepers nor yield daemons provide. A fuller comparison is in `COMPETITIVE.md`.

## 5. Architecture

```
                 on a cadence (minutes)
   ┌──────────────────────────────────────────┐
   │  AI strategy layer (OpenRouter)           │  regime classification;
   │  OFF the execution hot path               │  proposes parameters (clamped)
   └───────────────────┬──────────────────────┘
                       │ validated, clamped parameters only
                       ▼
   live on-chain ─▶ ┌──────────────────────────┐ ─▶ signed transactions
   reads (reserves, │  Deterministic core       │    (swaps, add/withdraw LP)
   balances, mid)   │  decide() · decideLp()    │
                    └───────────────┬──────────┘
                                    │ builders + post-conditions
                                    ▼
                    ┌──────────────────────────┐
                    │  Stacks adapter           │  Clarity contract calls,
                    │  (this repo)              │  signing, slippage guards
                    └──────────────────────────┘
```

### 5.1 Deterministic execution core

A pure decision layer with no I/O. Given inventory, the on-chain mid price, and
parameters, it computes:

- **`decide()`** — inventory rebalancing toward a target sBTC/STX value split, acting
  only when drift exceeds a configurable band, sized to the gap.
- **`decideLp()`** — liquidity allocation toward a target LP fraction, gap-sized adds
  (half the gap in sBTC for a 50/50 pool) and proportional withdrawals, constrained by
  available inventory and hard caps.

Because the core is pure and parameterized, its behavior is reproducible and auditable.

### 5.2 AI strategy layer (off the hot path)

On a cadence, DeepStack calls an LLM (via OpenRouter) to classify market regime and
propose parameters — band width, target split, slippage tolerance. Two invariants make
this safe:

1. **Every proposed value is clamped** to a safe range before use.
2. **Hard caps (maximum trade sizes) are never AI-set** — they remain fixed in code.

If no API key is configured or any error occurs, the agent falls back to deterministic
defaults. The LLM never signs or sizes a trade directly; it only nudges parameters the
deterministic core already validates. This "explainable AI over a deterministic core"
design is a deliberate contrast to black-box trading agents.

### 5.3 Safety model

Stacks supports **post-conditions** — assertions the chain enforces atomically. Through
live mainnet testing (§8) DeepStack established the correct model for AMM operations:

- **Strict input-cap post-conditions** on every write, bounding the maximum the agent
  can send (it can never overspend), and
- **On-chain `min-output` arguments** set from a fresh quote, bounding what is received.

An initial attempt using strict deny-mode receive assertions aborted safely on-chain —
revealing that the pool, not the core contract, sends the output token, and that swaps
perform a separate protocol-fee transfer. The transaction failed closed (no funds moved,
only a network fee lost), which both validated the safety posture and taught the correct
pattern. Additional rails: fresh-quote slippage guards, hard per-transaction size caps,
balance checks, mainnet-only execution gating, and confirmation polling between cycles
to prevent double-trading on stale balances. Live execution requires explicit double
opt-in.

### 5.4 The agent loop

Each cycle: read on-chain mid and wallet inventory (free balances and LP position) →
optionally AI-tune parameters → run `decideLp()` then `decide()` → act under guards.
The loop defaults to **observe mode** (no broadcasting); live mode is opt-in and capped.

## 6. Economics and incentive design

DeepStack pursues **fee-backed, sustainable yield — never token emissions or guaranteed
"high" returns.** Honestly accounted:

- **Rebalancing swaps cost fees** — they are risk management, not income.
- **Income sources, net of impermanent loss (IL):**
  1. **LP fee income** — a share of the pool's trading fee from other traders.
  2. **Liquidity-mining incentives** — where venues offer them.
  3. **Spread / arbitrage** — order-book quoting on Velar perps and cross-venue arbitrage.

On thin pools, LP fees alone may not exceed IL; the pilot's purpose is to **measure**
this transparently rather than assume it. A ~$1,000 self-funded pilot proves the
*mechanism*, not scale.

**Scalable model.** Like Steer/Gamma, the path beyond a single operator's capital is
**non-custodial vaults**: third parties deposit, the agent manages their liquidity, and
DeepStack earns a management/performance fee on AUM. This requires audited Clarity vault
contracts and is a deliberate later phase, not a current claim.

## 7. Composability with FlashStack

The author's prior project, **FlashStack** — a flash-loan protocol live on Stacks
mainnet (all three grant milestones delivered) — composes directly with DeepStack:
the agent can flash-borrow to rebalance inventory atomically (capital-efficient
rebalancing), and DeepStack liquidity deepens the same pools FlashStack's arbitrage
strategies use. This is a primitive pairing unique to this builder.

## 8. Implementation and validation

DeepStack is implemented in TypeScript against verified mainnet contracts using
`@stacks/transactions` v7.4.0. Key facts are not asserted from memory but verified
on-chain:

- **Venue:** Bitflow XYK pool `…xyk-pool-sbtc-stx-v-1-1`, entry contract
  `…xyk-core-v-1-2`; sBTC token `…sbtc-token`; STX leg is native STX.
- **Read path:** live pool reserves and constant-product mid, projected LP APR by
  turnover, and an idle-capital yield scan — all with no API keys.
- **Write path, validated on mainnet:** a live `swap-y-for-x` succeeded
  (`tx_status: success`, result `(ok u1411)`): 5 STX → 0.00001411 sBTC, exactly the
  quote. The earlier deny-mode attempt aborted safely (post-condition), costing only a
  network fee and teaching the correct safety model.
- **Transparency:** a single-file, backend-free dashboard renders volume facilitated,
  fees, success/abort counts, balances, LP position, and a transaction table — each row
  linking to the public explorer. Anyone can independently verify every figure.

The agent loop, LP add/withdraw, and AI tuning are wired and demonstrated in observe
mode; live execution is gated behind explicit opt-in and hard caps.

## 9. Roadmap

| Stage | Scope | Status |
|---|---|---|
| 1. Solo agent | One agent, one pool, AI-tuned, mainnet-validated | live |
| 2. Multi-venue | More sBTC pairs; **Velar perps quoting**; cross-venue arbitrage | next |
| 3. Vaults | Non-custodial Clarity vaults; fee on AUM | the revenue model |
| 4. Infrastructure | Open ALM tooling / white-label for Stacks protocols | the platform |

## 10. Risk analysis

- **Market / IL risk** — fees may not exceed impermanent loss on thin pools; mitigated
  by transparent measurement and conservative sizing, not by yield promises.
- **Smart-contract / execution risk** — mitigated by input-cap post-conditions,
  on-chain min-output guards, hard caps, and a mainnet-validated path that fails closed.
- **Competitive risk** — first-party keepers (Bitflow) could extend into AI or perps;
  mitigated by independence, cross-venue reach, the perps focus, and open source.
- **Custody risk (future vaults)** — managing third-party funds requires audited
  contracts and compliance; treated as a gated later phase.
- **Key/operational risk** — keys held only in local environment files, never logged or
  committed; per-transaction and daily caps bound exposure.

## 11. Conclusion

DeepStack is a working, mainnet-validated, AI-tuned market-making agent for Bitcoin
DeFi, built by an operator with a delivered Stacks track record (FlashStack) and live
market-making experience (Dexalot). It does not overclaim: rebalancing costs fees,
profitability depends on volume and incentives net of IL, and first-party automation
already exists for passive liquidity. Its defensible niche is **independent, AI-driven,
cross-venue active market-making — especially Velar perps** — delivered transparently
and open source. The honest, measurable approach is the point: prove whether fee income
beats IL on Bitcoin-native venues, in public, and build the automated liquidity layer
Bitcoin DeFi still lacks.

## References

- Stacks & sBTC — https://www.stacks.co/sbtc
- Bitflow HODLMM & Keepers — https://bitflowfinance.medium.com/the-bitflow-hodlmm-a-concentrated-liquidity-engine-for-expanding-btc-capital-markets-dd58c62489f5
- AIBTC — https://github.com/aibtcdev
- Stacks Endowment grants — https://stacksendowment.co/grants
- DeepStack repository, M1 plan, competitive analysis, and vision — this repository's `docs/`
