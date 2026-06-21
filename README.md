# DeepStack

> A Bitcoin-native liquidity / market-making agent for Stacks DeFi.

**Status:** proof-of-concept spike for a Stacks Endowment *Getting Started* grant (Q2 2026).

## The problem

Stacks holds ~**$545M of sBTC** but only ~**$5M of DEX TVL** (Q1 2026): a large pool of
Bitcoin-backed capital with almost nowhere liquid to trade it. Bitcoin DeFi has lacked
operators with real market-making experience. This project ports a proven CLOB/CEX-grade
market-making stack (live on Dexalot/Avalanche) to Stacks to close that depth gap.

## Architecture

```
                 ┌─────────────────────────────┐
   on a cadence  │   AI strategy layer          │   regime classification,
   (minutes)     │   (OpenRouter, OFF hot path) │   risk posture, param tuning
                 └──────────────┬──────────────┘
                                │ parameters only (spread, range, inventory)
                                ▼
   live data ──▶ ┌─────────────────────────────┐ ──▶ quotes / rebalance bands
   (pools,       │   Deterministic MM core      │     (the live bot acts on these)
    reserves)    │   quoting · inventory · IL   │
                 └──────────────┬──────────────┘
                                │ read-only
                                ▼
                 ┌─────────────────────────────┐
                 │  Stacks adapter              │  Bitflow/ALEX/Velar reads,
                 │  (this repo)                 │  Clarity read-only calls,
                 └─────────────────────────────┘  wallet/signing (later)
```

**Design rule:** an LLM is **never** in the hot quoting loop — only the deterministic
core places/manages orders. The AI layer feeds it *parameters* on a slow cadence. This
keeps execution fast, cheap, deterministic, and explainable (and grant-credible).

## What the spike already does

`src/index.ts` runs a real read-and-decide loop with **no API keys**:

1. Pulls **live** Bitflow pools (`/ticker`, public) — real USD liquidity + prices.
2. Surfaces BTC-flavoured pools (the thesis target).
3. **Introspects** a pool's Clarity contract on-chain (Hiro interface endpoint) and
   calls a no-arg read-only function via `@stacks/transactions`.
4. Runs the deterministic MM core to emit a concrete **quote + rebalance band**.

### Run it

```bash
npm install
npm run spike      # live read-and-decide loop, prints quote + rebalance band
npm run yield      # idle-capital yield scan (Stacks lending, read-only)
npm run m1:dryrun  # build+sign an add-liquidity tx locally, NOT broadcast (M1)
npm run m1:agent   # agent loop: read mid+inventory -> decide rebalance (observe)
                   #   add --live --yes-mainnet to execute (guarded, capped, mainnet-only)
npm run typecheck  # tsc --noEmit
```

### Idle-capital yield (`npm run yield`)
DeepStack's inventory isn't always fully deployed in market-making. The `src/yield/`
module ranks where idle inventory could earn the best **risk-adjusted** yield on
Stacks (currently Zest V2, via DefiLlama's public API) behind a venue-agnostic
`YieldVenue` interface — no bridge, read-only, no funds move. Note: Stacks lending
yields are very low today, so this is a monitor that auto-surfaces opportunities as
rates rise; execution (supply/withdraw) is deferred behind the same interface.

Copy `.env.example` to `.env` to override defaults (all have safe public fallbacks).

## Public dashboard (`dashboard/`)
A backend-free, single-file metrics dashboard (`dashboard/index.html`) that reads **live
on-chain data** (Hiro API) for the agent's wallet and renders volume facilitated, sBTC
traded, network fees, success/abort counts, balances, portfolio value, and a verifiable
transaction table (each row links to the explorer). No private data, no server.

- Preview locally: open `dashboard/index.html`, or `npx serve dashboard`.
- Deploy publicly (pick one): `vercel deploy dashboard` · GitHub Pages · Netlify drop.

## Roadmap (grant milestones)

- **M1 (wk 1–4):** Stacks adapter + testnet PoC (this repo → testnet reads, signing).
- **M2 (wk 5–8):** live mainnet pilot on one sBTC pool (~$1K self-funded inventory) +
  public dashboard (volume facilitated, fees, IL-adjusted return, uptime).
- **M3 (wk 9–12):** publish 30-day results, open-source the adapter, Velar perps spike.

## Layout

| File | Role |
|---|---|
| `src/bitflow.ts` | live pool/liquidity data (public Bitflow ticker API) |
| `src/stacks.ts`  | on-chain Clarity reads + contract introspection |
| `src/mm.ts`      | deterministic market-making core (quote + rebalance band) |
| `src/feeYield.ts`| projected LP fee yield (APR) by daily turnover |
| `src/index.ts`   | end-to-end spike wiring the above together |

> Note: the Bitflow sBTC-STX pool is a **constant-product (XYK) full-range** AMM, so the
> `mm.ts` band drives **rebalancing/hedging thresholds**, not a concentrated LP range.
> The write-side plan (signing, post-conditions, slippage) is in [`docs/M1_PLAN.md`](docs/M1_PLAN.md).

## Prior art

Built on a live Dexalot (Avalanche) AVAX/USDC market-making bot — proof of relevant
skills. This repo ports that execution discipline to Bitcoin-native venues on Stacks.

## License

MIT (intended — adapter to be open-sourced as ecosystem infrastructure).
