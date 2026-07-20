# DeepStack — Integration Guide

*How to run the DeepStack liquidity agent, verify what it's doing, and adapt it to a new
pool or chain. MIT licensed — fork it, run it, build on it.*

DeepStack is an autonomous liquidity agent for Bitflow XYK pools on Stacks. A deterministic
core makes every trading decision; an LLM only tunes bounded parameters off the hot path.
Every action is journalled and every guard fails closed.

## Run it in 60 seconds (observe mode — broadcasts nothing)

```bash
git clone https://github.com/mattglory/deepstack && cd stacks-liquidity-agent
npm install
npm test            # deterministic core, safety gate, RPC failover, P&L — all pure, no network
npm run m1:safety   # live oracle-sanity check against mainnet
npm run m1:agent    # one observe cycle: prints the decision it WOULD make, trades nothing
```

Observe mode needs no keys and touches no funds. It reads the live pool, values inventory,
runs the safety gate, and prints the rebalance/LP decision it would take.

## Go live (explicit double opt-in, mainnet only)

```bash
cp .env.example .env      # then fill in the wallet + options (see below)
npm run m1:agent -- --live --yes-mainnet --interval 1800 --max-trades 60
```

Broadcasting requires **both** `--live` and `--yes-mainnet`. Without them the agent is
observe-only no matter what else is set. `--interval` is the cycle period in seconds;
`--max-trades` is a lifetime ceiling, not a target — the band decides what actually trades.

### Environment (`.env`)

| Var | Purpose |
|---|---|
| `STACKS_NETWORK` | `mainnet` to trade; defaults to `testnet` (safe) |
| `STACKS_PRIVATE_KEY` | agent wallet — raw hex key or 12/24-word seed. Read only from here; never logged |
| `PAIR` | which pool (default `sbtc-stx`; registry in `src/m1/contracts.ts`) |
| `TARGET_LP_FRACTION` | LP allocation as a share of portfolio (0 = MM-only) |
| `OPENROUTER_API_KEY` | activates the AI tuning layer; without it, safe deterministic defaults |
| `STACKS_API_FALLBACKS` | comma-separated backup RPC endpoints (failover) |
| `HEALTHCHECK_URL` | dead-man's-switch ping (e.g. healthchecks.io) |
| `MAX_POOL_SHARE_BPS` | exit-liquidity cap — refuse LP adds above this share of the pool (default 200) |

Full pilot deployment (VPS, systemd, monitoring, telemetry mirror): see
[PILOT_DEPLOY.md](PILOT_DEPLOY.md).

## Architecture — where to look

| Concern | File |
|---|---|
| Deterministic decision core (rebalance, LP, vol-scaled band) — pure, tested | `src/m1/agent.ts` |
| Pool venue registry (add a pair here, nowhere else) | `src/m1/contracts.ts` |
| Write-side tx builders (swap / add / withdraw), post-conditions | `src/m1/actions.ts` |
| Read-only quotes + slippage guards | `src/m1/quotes.ts` |
| Safety gate (oracle-sanity, drawdown, pause) — fails closed | `src/m1/safety.ts` |
| RPC failover | `src/m1/rpc.ts` |
| AI tuning (bounded, off hot path) | `src/m1/ai/` |
| Evidence: journal + telemetry | `src/m1/journal.ts`, `src/m1/metrics.ts` |
| FlashStack flash-rebalance receiver + ops | `contracts/deepstack-rebalance-receiver.clar`, `src/m2/` |

## Adapt it to a new pool (config, not code)

Adding a Bitflow XYK pair is one entry in the `PAIRS` registry in `src/m1/contracts.ts`:

```ts
"my-pair": {
  key: "my-pair", poolSymbol: "X-Y",
  pool: { address: BF, name: "xyk-pool-x-y-v-1-1" },
  lp:   { address: BF, name: "xyk-pool-x-y-v-1-1", asset: "pool-token", decimals: 6 },
  x: { address: "...", name: "x-token", asset: "x-token", decimals: 8, symbol: "X", coingecko: "..." },
  y: { address: BF, name: "token-stx-v-1-2", decimals: 6, native: true, symbol: "STX", coingecko: "blockstack" },
},
```

Select it with `PAIR=my-pair`. The whole stack is generalised to x/y with per-token decimals
and native-vs-SIP-010 post-conditions, so either leg can be native STX. The `coingecko` id
feeds the external price reference the safety gate needs — a pair without a reliable oracle
should not be traded (the gate can't protect it).

## Adapt it to a new venue or chain

The decision core (`agent.ts`) is pure and venue-agnostic. Porting means providing four
things behind the same interfaces: read pool reserves → a mid; read wallet balances; build
the venue's swap/add/withdraw transactions with input-cap post-conditions; supply an external
price oracle for the safety gate. `actions.ts` and `quotes.ts` are the Bitflow-specific
surface to replace; `agent.ts`, `safety.ts`, `metrics.ts`, and the AI layer carry over.

## Verify any claim independently

Nothing here asks for trust. Transactions are on the Stacks explorer; the dashboard derives
every figure live from the chain; the analysis scripts (`analysis/`) reproduce the band and
cost models; `npm test` runs the decision core offline. The agent's own reasoning is in the
per-cycle journal (`journal/*.jsonl`), including every HOLD with its reason.
