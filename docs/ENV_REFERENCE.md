# Environment variable reference

Every variable the code reads from the environment (`.env` on the agent host, or the shell for operator CLIs). Assessment 2026-11, DSA-22 / roadmap B2: production configuration must be reproducible from this file plus a secure backup of the values.

- **Secret** = treat as a credential: never log, commit or paste it; keep it in `.env` (0600) and the encrypted backup.
- **Code fallback** is what the code uses when the variable is unset, as written at the first use found; when several files read it with different fallbacks, it says *varies* and you should read the files. Unset with no fallback means off / not configured.
- `src/env-reference.test.ts` fails CI if the code reads a `process.env` variable that is not listed here.

| Variable | Secret | Code fallback | Read by | Purpose |
|---|---|---|---|---|
| `AGENT_SERVICE` |  | `"deepstack-agent"` | m1/rotate-key-cli.ts |  |
| `ALLOCATION_MODE` |  | `"static"` | m1/allocation.ts | static \| adaptive regime allocation |
| `ALLOC_DLMM_MAX_CAP` |  | `0.25` | m1/allocator-cli.ts |  |
| `ALLOC_INCENTIVE_CAP_BONUS` |  | `0.05` | m1/capital-allocator.ts |  |
| `ALLOC_MAX_CHANGE` |  | `0.1` | m1/capital-allocator.ts |  |
| `ALLOC_METRICS_SOURCE` |  | `"remote"` | m1/allocator-cli.ts |  |
| `ALLOC_RESERVE_FLOOR` |  | `0.5` | m1/capital-allocator.ts |  |
| `ALLOC_XYK_MAX_CAP` |  | `0.45` | m1/allocator-cli.ts |  |
| `APP_DIR` |  | unset | m1/kill.ts | App root for the KILL file (default: the code's own root, /opt/deepstack) |
| `BITFLOW_TICKER_API` |  | `` | config.ts |  |
| `CAPITAL_FLOWS_PATH` |  | `"journal/capital-flows.json"` | m1/metrics.ts |  |
| `COINGECKO_API_KEY` | **yes** | unset | m1/safety.ts | CoinGecko Demo key: avoids the shared anonymous rate limit (403s). REQUIRED in practice once C5 makes a missing source fail closed |
| `CYCLE_TIMEOUT_MS` |  | `45 * 60_000` | m1/agent-cli.ts | Cycle watchdog (C2) |
| `DEFENSIVE_Y_FRACTION` |  | `0.35` | m1/allocation.ts |  |
| `DLMM_DEPOSIT_PATH` |  | `"journal/dlmm-deposit.json"` | m1/dlmm-fees.ts |  |
| `DLMM_FAILSTREAK_STATE_PATH` |  | `"journal/dlmm-failstreak.json"` | m1/dlmm-failstreak-state.ts |  |
| `DLMM_FAIL_STREAK_LIMIT` |  | `2` | m1/agent-cli.ts | Failed DLMM attempts before broadcasts stop until a human resets |
| `DLMM_HALF_WIDTH` |  | `3` | m1/agent-cli.ts, m1/dlmm-recenter-cli.ts | Fallback DLMM half-width |
| `DLMM_LIVE` |  | unset | m1/agent-cli.ts | Live agent: 1 = DLMM may broadcast (with the other gate terms) |
| `DLMM_MAX_POOL_SHARE_BPS` |  | `1000` | m1/dlmm-recenter-exec.ts |  |
| `DLMM_MAX_TARGET_USD` |  | `250` | m1/dlmm-recenter-cli.ts, m1/dlmm-recenter-exec.ts | Hard cap on DLMM position size; also caps the re-add |
| `DLMM_OBSERVE_PAIR` |  | *varies by reader* | m1/agent-cli.ts, m1/dlmm-fees-cli.ts | Live agent: enables the DLMM step for this pair (unset = DLMM off). CLIs use it as a default pair |
| `DLMM_PAIR` |  | `"stx-usdcx"` | m1/dlmm-recenter-cli.ts, m1/dlmm-smoke-cli.ts |  |
| `DLMM_PENDING_STATE_PATH` |  | `"journal/dlmm-pending-readd.json"` | m1/dlmm-pending-state.ts |  |
| `DLMM_PIN_HALF_WIDTH` |  | *varies by reader* | m1/dlmm-recenter-exec.ts, m1/dlmm-width-cli.ts | Pins the DLMM half-width in bins (overrides the volatility sizing) |
| `DLMM_REBALANCE_CHUNK_VALUE_Y` |  | `600` | m1/dlmm-recenter-exec.ts |  |
| `DLMM_REBALANCE_MAX_DIVERGENCE_BPS` |  | `300` | m1/dlmm-recenter-exec.ts |  |
| `DLMM_REBALANCE_SLIPPAGE_BPS` |  | `100` | m1/dlmm-recenter-exec.ts |  |
| `DLMM_WITHDRAW_MIN_OUT_TOLERANCE_BPS` |  | (C3, in progress) | m1/dlmm-recenter-exec.ts | Tolerance for per-bin withdraw minimums derived from the read position (roadmap C3) |
| `DLMM_TARGET_USD` |  | `40` | m1/agent-cli.ts, m1/dlmm-recenter-cli.ts | Size of a new DLMM position (USD) |
| `DRAWDOWN_BASELINE_PATH` |  | `"journal/drawdown-baseline.json"` | m1/risk-state.ts | Persistent drawdown baseline file (C1) |
| `DRAWDOWN_DEFENSIVE` |  | `0.08` | m1/allocation.ts |  |
| `EXEC_MAX_DEFER` |  | `6` | m1/agent.ts |  |
| `EXEC_MIN_EDGE_BPS` |  | `0` | m1/agent.ts |  |
| `EXPERIMENT_BAND_BPS` |  | `50` | m1/experiment.ts |  |
| `EXPERIMENT_BAND_MODE` |  | `""` | m1/experiment.ts |  |
| `EXPERIMENT_MAX_COST_STX` |  | `8` | m1/experiment.ts |  |
| `EXPERIMENT_MAX_DAYS` |  | `4` | m1/experiment.ts |  |
| `EXPERIMENT_MAX_REBALANCES` |  | `8` | m1/experiment.ts |  |
| `EXPERIMENT_STATE_PATH` |  | `"journal/experiment.json"` | m1/experiment.ts |  |
| `FLASH_FAILSTREAK_STATE_PATH` |  | `"journal/flash-failstreak.json"` | m1/flash-failstreak-state.ts |  |
| `FLASH_FAIL_STREAK_LIMIT` |  | `2` | m1/agent-cli.ts |  |
| `FLASH_LIVE` |  | unset | m1/agent-cli.ts | Flash route switch (NOT sufficient: the route is disabled by a code constant) |
| `FLASH_MAX_SWAP_Y_BASE` |  | `150_000_000` | m2/flash-rebalance-exec.ts |  |
| `HAVEN_ASSET` |  | `"USDCx"` | m1/haven.ts |  |
| `HAVEN_DEFENSIVE_FRACTION` |  | `0.4` | m1/haven.ts |  |
| `HAVEN_ELEVATED_FRACTION` |  | `0.15` | m1/haven.ts |  |
| `HAVEN_MIN_LIQ_USD` |  | `250_000` | m1/haven.ts |  |
| `HEALTHCHECK_URL` | **yes** | unset | m1/journal.ts | healthchecks.io ping URL (a capability: anyone holding it can send ok pings) |
| `HIRO_API_KEY` | **yes** | unset | m1/rpc.ts | Hiro API key: higher rate limit; sent only to *.hiro.so over https |
| `JOURNAL_DIR` |  | `"journal"` | m1/journal.ts, m2/pnl-cli.ts |  |
| `KEY_BACKUP_RECIPIENT_FILES` |  | unset | m1/rotate-key-cli.ts | Custodian public-key files for the rotation backup (A1); public keys, not secrets |
| `KILL_SWITCH` |  | unset | m1/dlmm-recenter-exec.ts, m1/kill.ts, m1/safety.ts, m2/flash-rebalance-exec.ts | 1 = halt trading (needs a restart; the KILL file does not) |
| `LP_RANGE_BPS` |  | `150` | config.ts |  |
| `MAX_CONSECUTIVE_FAILURES` |  | `5` | m1/agent-cli.ts | Circuit breaker on consecutive failed cycles |
| `MAX_POOL_SHARE_BPS` |  | `200` | m1/agent.ts | XYK position cap as a share of the pool |
| `MAX_SAMPLES` |  | `2000` | m1/metrics.ts |  |
| `METRICS_GIST_ID` |  | unset | m1/publish.ts | Gist mirrored for the public dashboard |
| `METRICS_GIST_TOKEN` | **yes** | unset | m1/publish.ts | GitHub token for that gist (use a fine-grained token: DSA-29) |
| `METRICS_PATH` |  | `"dashboard/metrics.json"` | m1/lvr-cli.ts, m1/metrics.ts |  |
| `MIN_TRADE_VALUE_Y` |  | `5` | m1/agent-cli.ts | Smallest XYK trade worth sending |
| `MS_PUBKEYS` |  | *varies by reader* | m1/vault-v2-multisig-cli.ts |  |
| `MS_VAULT` |  | `""` | m1/vault-v2-multisig-cli.ts |  |
| `OPENROUTER_API_KEY` | **yes** | unset | m1/ai/tune.ts | Enables AI parameter tuning (tightening only since C6) |
| `OPENROUTER_MODEL` |  | `"~anthropic/claude-sonnet-latest"` | m1/ai/tune.ts | OpenRouter model alias |
| `OWNER_WITHDRAW_ADDRESSES` |  | `""` | m1/owner-withdraw-cli.ts | Allow-list for m1:withdraw destinations (owner cold addresses) |
| `PAIR` |  | `"sbtc-stx"` | m1/contracts.ts |  |
| `POOL_FEE_BPS` |  | `50` | m1/lvr-cli.ts |  |
| `POOL_WATCH_PATH` |  | `"journal/pool-watch.jsonl"` | m1/pool-watch-cli.ts | Read-only candidate-pool watch log |
| `RPC_TIMEOUT_MS` |  | `15_000` | m1/rpc.ts | Per-attempt RPC timeout |
| `SENDER_ADDRESS` |  | `"SP000000000000000000002Q6VF78"` | config.ts |  |
| `STACKS_ACCOUNT_INDEX` |  | `0` | m1/wallet.ts | Account derived from a seed phrase (ignored for a hex key) |
| `STACKS_API` |  | `"https://api.mainnet.hiro.so"` | config.ts | Primary Stacks API (https only since C8) |
| `STACKS_API_FALLBACKS` | **yes** | `""` | m1/rpc.ts | Comma-separated fallback APIs, tried in order; may embed a provider token in the URL (logged redacted since C8) |
| `STACKS_NETWORK` |  | `"testnet"` | m1/wallet.ts | mainnet \| testnet; defaults to testnet for safety. Production: mainnet |
| `STACKS_PRIVATE_KEY` | **yes** | unset | m1/wallet.ts | Agent signing key (hex key; a 12/24-word phrase is still accepted but should not be used: run m1:narrow-key) |
| `STRATEGY_PRIVATE_KEY` | **yes** | unset | m1/vault-v2-cli.ts | vault-v2 strategy key (operator CLI; never on the agent host for mainnet) |
| `STX_FEE_RESERVE` |  | `50` | m1/agent-cli.ts, m1/owner-withdraw-cli.ts | STX kept back for fees |
| `TARGET_LP_FRACTION` |  | `0` | m1/agent.ts, m1/allocation.ts | XYK LP leg (0 = off) |
| `TARGET_SPREAD_BPS` |  | `20` | config.ts |  |
| `VOL_DEFENSIVE` |  | `0.06` | m1/allocation.ts |  |
| `VOL_ELEVATED` |  | `0.04` | m1/allocation.ts |  |
| `WALLET_MIGRATIONS_PATH` |  | `"journal/wallet-migrations.json"` | m1/metrics.ts |  |
| `XYK_REF_MIN_OUT_BAND_BPS` |  | unset | m1/quotes.ts | Reference-floored min-out band (C5) |
| `XYK_TRADES_STATE_PATH` |  | `"journal/xyk-trades.json"` | m1/risk-state.ts | Lifetime XYK trade count file (C1) |

## Read through a computed name (not visible to the static check)

Keep this section complete by hand: `src/env-reference.test.ts` only sees literal `process.env.NAME` / `process.env["NAME"]` reads.

| Variable | Secret | Code fallback | Read by | Purpose |
|---|---|---|---|---|
| `EXTERNAL_PRICE_MAX_AGE_SECS` |  | `900` | m1/safety.ts (via a helper, C5) | Reference price staleness bound |
| `EXTERNAL_PRICE_MAX_SOURCE_DIVERGENCE_BPS` |  | `200` | m1/safety.ts (via a helper, C5) | Max CoinGecko vs DefiLlama disagreement |
| `MS_KEY_1` | **yes** | unset | m1/vault-v2-multisig-cli.ts (`MS_KEY_${n}`) | Multisig signer 1 key; testnet rehearsal CLI only; never on the agent host |
| `MS_KEY_2` | **yes** | unset | m1/vault-v2-multisig-cli.ts | Multisig signer 2 key (same rules) |
| `MS_KEY_3` | **yes** | unset | m1/vault-v2-multisig-cli.ts | Multisig signer 3 key (same rules) |

## Wallet watcher (`src/watcher/`, runs off the VPS)

Read through the watcher's own config object (also settable as CLI flags); see `docs/WALLET_WATCHER.md` for defaults.

| Variable | Secret |
|---|---|
| `WATCH_ADDRESSES` |  |
| `WATCH_NETWORK` |  |
| `WATCH_API` |  |
| `WATCH_API_FALLBACKS` |  |
| `WATCH_TIMEOUT_MS` |  |
| `WATCH_STATE_PATH` |  |
| `WATCH_MAX_PAGES` |  |
| `WATCH_RECOVERY_HOURS` |  |
| `WATCH_FAIL_AFTER` |  |
| `WATCH_FAILED_BURST` |  |
| `WATCH_LARGE_MOVE_PCT` |  |
| `WATCH_BALANCE_DROP_PCT` |  |
| `WATCH_CONTRACT_ALLOWLIST` |  |
| `WATCH_NOTIFY_MIN` |  |
| `WATCH_HEARTBEAT_URL` | **yes** |
| `WATCH_WEBHOOK_URL` | **yes** |
| `SLACK_WEBHOOK_URL` | **yes** |
| `OWNER_ALLOWLIST` |  |

## Production checklist (values live in the encrypted backup, never here)

- [ ] `STACKS_NETWORK=mainnet`, `STACKS_PRIVATE_KEY` a single hex key (not a phrase)
- [ ] `STACKS_API` and every `STACKS_API_FALLBACKS` entry are https; at least one fallback configured
- [ ] `HIRO_API_KEY`, `COINGECKO_API_KEY` set
- [ ] `HEALTHCHECK_URL` set and its alert channels tested
- [ ] DLMM: `DLMM_OBSERVE_PAIR`, `DLMM_LIVE`, `DLMM_TARGET_USD`, `DLMM_MAX_TARGET_USD`, `DLMM_PIN_HALF_WIDTH` recorded
- [ ] `OWNER_WITHDRAW_ADDRESSES` are cold owner addresses not derived from the retired phrase
- [ ] No `STRATEGY_PRIVATE_KEY` or `MS_KEY_*` on the agent host
