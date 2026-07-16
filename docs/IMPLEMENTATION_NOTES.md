# DeepStack — M1 Implementation Notes

Bitcoin-native automated liquidity-management agent for Stacks DeFi. This note maps the
Milestone 1 deliverables to the code that implements them and the on-chain evidence that
verifies them. Everything here is reproducible from the public repo
(github.com/mattglory/deepstack) against Bitflow's mainnet sBTC-STX pool.

## Architecture in one paragraph

A deterministic quant core makes every trading decision; an optional LLM layer only tunes
bounded parameters off the hot path and can never place a trade. The agent reads on-chain
pool reserves and wallet inventory (Hiro API + `@stacks/transactions` read-only calls),
computes a rebalance/LP decision, passes it through a fail-closed safety gate, then signs
and broadcasts with strict input-cap post-conditions and on-chain min-output guards. Every
tick is journaled; heartbeat + mid + inventory samples publish to a public dashboard.

## Deliverable → code map

| M1 deliverable | Implementation | Notes |
|---|---|---|
| Stacks adapter for mainnet pool ops | [src/m1/contracts.ts](../src/m1/contracts.ts), [src/m1/actions.ts](../src/m1/actions.ts), [src/m1/quotes.ts](../src/m1/quotes.ts) | `PAIRS` registry + `activePool()`; adding an XYK pair is one config entry |
| Signing/broadcast: add, remove, swap, rebalance | [src/m1/actions.ts](../src/m1/actions.ts) | `buildSwapYForX / buildSwapXForY / buildAddLiquidity / buildWithdrawLiquidity`, generic `sendCapPC()` (native STX vs SIP-010) |
| Safety controls | [src/m1/safety.ts](../src/m1/safety.ts), [docs/SAFETY_CONTROLS.md](SAFETY_CONTROLS.md) | Allow-mode + input-cap PCs, fresh min-output, slippage, hard size caps, oracle-sanity divergence halt, kill-switch, drawdown halt — all fail-closed |
| Deterministic decision core | [src/m1/agent.ts](../src/m1/agent.ts) | pure `decide()` / `decideLp()`; unit-tested |
| Autonomous agent loop | [src/m1/agent-cli.ts](../src/m1/agent-cli.ts) | observe by default; live behind `--live --yes-mainnet`; self-confirms via `waitForTx`, `--max-trades` per run |
| AI tuning layer (off hot path) | [src/m1/ai/](../src/m1/ai/) | OpenRouter regime classifier → params, every value clamped; falls back to defaults without a key; hard caps never AI-set |
| Public dashboard | [dashboard/index.html](../dashboard/index.html) | single-file, reads live Hiro API + `metrics.json`; portfolio, volume, fees, allocation, LP, uptime, mid-history, IL-adjusted return |
| Telemetry + audit trail | [src/m1/metrics.ts](../src/m1/metrics.ts), [src/m1/journal.ts](../src/m1/journal.ts) | `metrics.json` (heartbeat/mid/inventory) + per-tick JSONL journal + healthcheck dead-man's-switch |
| Unit tests | [src/m1/agent.test.ts](../src/m1/agent.test.ts) | 15 tests over `decide`, `decideLp`, slippage, `assessSafety`; `npm test` |

## Safety model (the part that matters most)

The first mainnet attempt used Deny-mode post-conditions and **aborted** (tx
`95b112e1…`) even though the contract returned `(ok …)` — because in Bitflow's XYK pool the
**pool** (not the core) sends the output token, and swaps do a separate protocol-fee
transfer. That abort is kept as evidence: it proves the guards fail closed and cost only a
fee. The corrected model — **Allow-mode + strict input-cap post-conditions**, with output
bounded on-chain by the contract's `min-*` argument — is the standard AMM pattern and is
what every transaction below uses. Full write-up with code refs and verify-it-yourself
commands in [SAFETY_CONTROLS.md](SAFETY_CONTROLS.md).

## On-chain evidence (agent wallet `SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60`)

10 successful mainnet transactions: 6 swaps (both directions), 2 add-liquidity, 1
remove-liquidity, and 1 fully autonomous rebalance.

| Action | txid | result |
|---|---|---|
| swap-y-for-x | `10fcec81c7646400373b861430b10e14f830195ed09a677cd0841c2db37923b6` | ok |
| swap-y-for-x | `5c3b82c7fd4b52a6a560dca9f6cc9a0aa040578dd8020fba82f954757ac4b857` | ok |
| add-liquidity | `120dfbab67a2fd4b882bc389965208781d30397e63d0b2fe431f2a0e04d54be7` | ok |
| add-liquidity | `41632e677216fd6005f5b7bcdbd2d22b4ae6ffeeae3c0ddae9a53936cb7e7f03` | ok |
| withdraw-liquidity | `1545adc3529d5a53948f8e6f2bece1686372566185596097a5023101bf40c557` | ok |
| swap-x-for-y | `5f8a6257e70139e7b919f7584921cc19169a5f90a7042b5e83bd794aed73f9d3` | ok |
| swap-y-for-x | `50806fac5d81ae1043eb57faa145aad46d4939d16dc034d07f1246ac582677a8` | ok |
| swap-y-for-x | `7c1ccebfbb9741457b20b56b5d9e93db935bef6bfd8a19c0c0322f145b2e0453` | ok |
| **autonomous rebalance** (swap-x-for-y) | `f1929c762bdbd78dfa591e30a2e243e068dc79ce201606de50097d5afd47c902` | ok, block 8551293 |
| safety abort (Deny-mode, evidence) | `95b112e1a49f1ab1fabbe53f091ed9abfd3de6177beac02fa6b17fe6cf95f7d0` | abort_by_post_condition |

Explorer: `https://explorer.hiro.so/txid/<txid>?chain=mainnet`

## The autonomous rebalance, step by step

Run: `npm run m1:agent -- --live --yes-mainnet`. The agent, with no hardcoded trigger:

1. **Tuned itself** — AI classified the market as `calm` and set band=400bps, slip=80bps.
   Journal: `{"type":"tune","regime":"calm","rationale":"Drift is only at the band edge
   with no signs of elevated volatility…","set":{"targetY":0.5,"bandBps":400,"slipBps":80}}`
2. **Read inventory** — free 0.00099957 sBTC + 314.82 STX; sBTC share 55.0% vs 50% target.
3. **Passed the safety gate** — pool mid 384,757 vs external 385,455 STX/sBTC, divergence
   0.18%, pool active → SAFE.
4. **Decided** — `swap-x-for-y 0.00009067 sBTC → STX` (x share 55.0% > target → sell x).
5. **Executed and self-confirmed** — txid `f1929c76…`, `status: success (ok u34711171)`.

The full tick is one line in `journal/2026-07-15.jsonl` linking decision → txid → status.

## How to reproduce / verify

```bash
npm install
npm test                       # 15/15 unit tests
npm run typecheck              # clean
npm run m1:safety              # live oracle-sanity check, prints SAFE/HALT + reasons
npm run m1:agent               # observe-only: prints the decision it WOULD make
```

Broadcasting anything requires the explicit `--yes-mainnet` (smoke) or `--live
--yes-mainnet` (agent) double opt-in, is mainnet-only, and is bounded by hard per-tx caps.

## Known limitations (carried into M2)

- Bitflow sBTC-STX is full-range XYK — no concentrated ranges, so MM levers are LP timing +
  inventory rebalancing, not quoting. True quoting edge is reserved for a Velar perps spike
  (M2, research-only given the unremediated Feb 2026 exploit).
- Single-operator, single wallet. A pooled multi-user vault is a future audited Clarity
  build, not part of this pilot.
- IL-adjusted return on the dashboard is baselined from first sample; a 30-day pilot (M2)
  produces the statistically meaningful figure.
