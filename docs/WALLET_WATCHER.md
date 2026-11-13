# Wallet watcher (A4 / DSA-06)

An independent, **read-only** monitor for the agent's hot wallet
(`SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60`). It runs **off the VPS**, so a compromised or
dead VPS can neither silence it nor take it down with the agent.

It never signs, never broadcasts, and never loads a key or seed phrase. Its only network
traffic is HTTP GETs to the public Hiro API, plus POSTs to the alert webhooks you configure.
Code: `src/watcher/`. Entry point: `npm run watch:wallet`.

## What it watches

Each poll, for each watched address:

| Read | Endpoint |
|---|---|
| chain tip | `GET /extended` (`chain_tip.block_height`) |
| balances **at that tip** | `GET /extended/v1/address/{a}/balances?until_block={tip}` |
| confirmed txs with their asset movements | `GET /extended/v1/address/{a}/transactions_with_transfers?limit=50` (more pages, up to `WATCH_MAX_PAGES`, only when catching up) |
| pending txs | `GET /extended/v1/address/{a}/mempool` |
| nonce gaps | `GET /extended/v1/address/{a}/nonces` (`detected_missing_nonces`) |

That is about 5 requests per address per poll. Hiro's unauthenticated limit is 50 per minute.
Balances are read at the same height the tx list is cut at. A tx that confirms between the
two reads waits for the next poll, so it cannot produce a false balance-drop alert.

Response shapes were checked against live mainnet on 2026-11-03. Trimmed copies (public
on-chain data only) are in `src/watcher/fixtures/`.

## Severities and rules

Every new tx is classified, whether pending in the mempool or confirmed.

| Severity | Rule | Fires when |
|---|---|---|
| CRITICAL | `stx-transfer-unlisted` | the wallet sends an STX transfer to an address not on `OWNER_ALLOWLIST` |
| CRITICAL | `transfer-unlisted` | any STX, FT or NFT leaves the wallet to a recipient that is not the wallet itself, an owner, an allowlisted contract, or a burn. This applies **whatever contract was called**, so a drain routed through an allowlisted router still fires |
| CRITICAL | `unlisted-contract` | the wallet calls a contract that is not a call target on the allowlist |
| CRITICAL | `deploy` | a contract is deployed from the wallet |
| CRITICAL | `balance-drop` | an asset's balance fell more than `WATCH_BALANCE_DROP_PCT` beyond what the new, non-CRITICAL txs explain. Fees are counted |
| HIGH | `failed` | a tx from the wallet was aborted (`abort_by_response`, `abort_by_post_condition`, ...) |
| HIGH | `failed-burst` | `WATCH_FAILED_BURST` or more failed txs since the last poll |
| HIGH | `nonce-gap` | Hiro reports missing nonces (a stuck or dropped tx) |
| HIGH | `large-movement` | one tx moved more than `WATCH_LARGE_MOVE_PCT` of an asset's prior balance, even through allowlisted contracts |
| HIGH | `history-gap` | more new txs arrived than one poll fetches, so some may be unclassified |
| HIGH | `state-corrupt` | the state file was unreadable as JSON or invalid (see below) |
| HIGH | `monitoring-failure` | every source failed for `WATCH_FAIL_AFTER` polls in a row. Until this clears, the wallet is **unwatched** |
| INFO | `allowlisted-call`, `owner-transfer`, `incoming` | routine activity. Summarised as counts per rule when there are many |
| INFO | `baseline`, `monitoring-recovered`, `test-alert` | messages about the watcher itself |

**Dedup.** Each alert has a key, normally `txid:rule`. The state file records every key that
has already been delivered, so the same tx and rule never alert twice. When a tx moves from
the mempool to confirmed, the rules it already fired while pending are not repeated. Only new
facts fire, such as the transfers that became visible on confirmation, or `failed`.

**Notification policy.** Every alert is printed to stdout. A notification is sent when at
least one alert is at `WATCH_NOTIFY_MIN` or above (default `HIGH`), and pending INFO alerts
are added to it as a summary. Messages about the watcher itself are always sent. If no
channel accepts a notification, its HIGH and CRITICAL alerts stay in the state file's
`outbox`, are retried on the next poll, and the heartbeat pings `/fail`.

### Allowlist (`src/watcher/allowlist.ts`)

This is a copy of what the agent actually calls, made on purpose so the watcher does not
depend on agent code. If the agent starts calling something new, add it here in the same
change. Each entry cites its source:

| Contract | Kind | Source |
|---|---|---|
| `SM1793…HCCR.xyk-core-v-1-2` | call | `src/m1/contracts.ts:11-14`, `src/m1/actions.ts:95-97` |
| `SM1FKXG…YXKD.dlmm-liquidity-router-v-1-2` | call | `src/m1/dlmm-write.ts:15-16, 154-202` |
| `SM1FKXG…YXKD.dlmm-swap-router-v-1-2` | call | `src/m1/dlmm-write.ts:208, 225-227` |
| `SP20XD46…VG5.flashstack-stx-core` | call | `src/m2/flash-rebalance-exec.ts:19, 122-124` |
| `SP23PF43…WK60.deepstack-rebalance-receiver` | call | `src/m2/flash-rebalance-exec.ts:20, 97-99` |
| `SM3VDXK…JFQ4.sbtc-token` | call (rotation `transfer`) | `src/m1/contracts.ts:44`, `src/m1/key-rotation.ts:29-33` |
| `SP120SB…CNE.usdcx` | call (rotation `transfer`) | `src/m1/key-rotation.ts:35-39` |
| `SM1793…HCCR.xyk-pool-sbtc-stx-v-1-1` | call (LP `transfer`) and counterparty | `src/m1/contracts.ts:42-43`, `src/m1/key-rotation.ts:23-27` |
| `SM1793…HCCR.xyk-pool-stx-aeusdc-v-1-2` | counterparty | `src/m1/contracts.ts:52-53` |
| `SM1793…HCCR.token-stx-v-1-2` | counterparty | `src/m1/contracts.ts:45`, `src/m1/dlmm-write.ts:21` |
| DLMM pools `ststx-stx-v-1-bps-1`, `stx-usdcx-v-2-bps-10`, `sbtc-usdcx-v-1-bps-10`, `stx-usdcx-v-1-bps-10` | counterparty | `src/m1/dlmm-read.ts:48-55` |
| `SP31C60QVZKZ9CMMZX73TQ3F3ZZNS89YX2DCCFT8P` | counterparty | not in source. Seen on chain receiving the protocol-fee leg of every `xyk-core` swap (132 times in the wallet's history) |

On testnet the allowlist is the vault v2 rehearsal contracts
(`ST2ZB…W5A.deepstack-vault-v2` and `-v2-token`, from `src/m1/vault-v2-cli.ts:41-42`).

"Call" entries are the contracts the wallet may call directly. "Counterparty" entries may
*receive* the wallet's funds inside an allowlisted call, but a direct call to one is still
CRITICAL. Owner addresses are **not** built in. Set them with `OWNER_ALLOWLIST`.

The wallet's own history includes attended operator actions that the watcher, correctly,
classifies as CRITICAL until they are allowlisted: STX sent to `SP111MN…EK0K` and
`SP12AS8…9HQS`, calls to the v1 vault `deepstack-vault`, calls to the Bitflow aggregator
`agg-d-v-1-sh-0` and the Velar wrapper, and three deploys. Matt needs to confirm which of
those destination addresses belong to the owner before they go into `OWNER_ALLOWLIST`.

## Configuration

Everything is read from the environment. The flags `--network`, `--addresses`, `--state` and
`--api` override the matching variables.

| Variable | Default | Meaning |
|---|---|---|
| `WATCH_ADDRESSES` | the agent wallet | comma-separated list of addresses (required on testnet) |
| `WATCH_NETWORK` | `mainnet` | `mainnet` or `testnet` |
| `WATCH_API` | Hiro for the network | primary API base URL |
| `WATCH_API_FALLBACKS` | – | comma-separated fallback endpoints that serve the same API (tried in order, sticky) |
| `WATCH_TIMEOUT_MS` | `10000` | timeout for each request (a hanging endpoint fails over) |
| `WATCH_STATE_PATH` | `watcher-state.json` | state file (gitignored) |
| `SLACK_WEBHOOK_URL` | – | Slack incoming webhook |
| `WATCH_WEBHOOK_URL` | – | generic JSON POST: `{source, network, severity, alerts:[{severity, rule, address, txid, summary, explorer}]}` |
| `WATCH_HEARTBEAT_URL` | – | healthchecks.io-style URL: GET on a healthy poll, GET `…/fail` when monitoring or delivery fails |
| `OWNER_ALLOWLIST` | – | addresses that outgoing transfers may legitimately go to |
| `WATCH_CONTRACT_ALLOWLIST` | – | extra contract ids to treat as allowed call targets (for example an attended aggregator) |
| `WATCH_LARGE_MOVE_PCT` | `25` | `large-movement` threshold |
| `WATCH_BALANCE_DROP_PCT` | `10` | `balance-drop` threshold |
| `WATCH_FAILED_BURST` | `3` | `failed-burst` threshold |
| `WATCH_FAIL_AFTER` | `3` | consecutive failed polls before `monitoring-failure` |
| `WATCH_NOTIFY_MIN` | `HIGH` | lowest severity that triggers a notification |
| `WATCH_RECOVERY_HOURS` | `24` | re-check window after a corrupt state file |
| `WATCH_MAX_PAGES` | `3` | maximum tx pages (50 each) fetched per poll when catching up |
| `WATCH_DRY_RUN` | – | `1` = no channel is a deliberate dry run. Without it, a watcher with no `SLACK_WEBHOOK_URL` / `WATCH_WEBHOOK_URL` reports itself unhealthy (exit 1, heartbeat `/fail`) and keeps its alerts in the outbox, so a mistyped variable cannot look healthy |

Flags: `--once` runs a single poll. `--interval <sec>` sets the loop period (default 300,
minimum 30). `--test-alert` sends a delivery check.

Exit codes with `--once`: `0` the poll was healthy, `1` the watcher is unhealthy (sources or
delivery failing), `2` a new CRITICAL alert was raised. The `2` lets a CI job turn red on
its own.

The webhook and heartbeat URLs are secrets, because anyone holding one can post to the
channel. They are only ever logged as `https://host/…(redacted)`, and payloads are built
only from public on-chain data.

## First run and state

**First run baselines and does not alert on history.** If an address has no state, its
fetched history (one page, the newest 50 txs) is marked as seen. The watcher sends one INFO
`baseline` message with the counts each severity *would* have had, and from then on alerts
only on new txs. Replaying months of attended operator actions as CRITICAL alerts would train
everyone to ignore the channel. The mempool is still classified on the first run, so a drain
that is pending right now still alerts.

**State file.** It is written atomically (temp file, then rename). It holds, per address, the
last evaluated height, the seen txids (at most 1000) and the last balances, plus the delivered
alert keys (at most 5000), the outbox, and the consecutive-failure counter.

**Corrupt state file.** The watcher does not silently reset to "seen nothing". Resetting would
either replay the whole history as alerts or, if baselined, hide whatever happened while the
state was broken. Instead it:

1. moves the file aside to `watcher-state.json.corrupt-<timestamp>` (kept as evidence, never overwritten),
2. raises a HIGH `state-corrupt` alert, which is always sent,
3. runs in recovery mode. Confirmed txs from the last `WATCH_RECOVERY_HOURS` are classified
   and alerted, and older history is baselined. The recovery window survives a failed poll
   because it is stored in the new state.

The cost is that alerts already sent inside the window may arrive a second time. A state file
for the wrong network counts as corrupt. A file that cannot be read at all (for example a
permissions error) makes the watcher exit with an error instead of resetting.

## Running it off the VPS

Use any host that is **not** the agent VPS and shares no credentials with it. It needs Node
22 and a clone of the repo (`npm ci`). It needs no wallet, `.env` or key.

**cron** (every 5 minutes, which is shorter than the agent's 30-minute cycle):

```cron
*/5 * * * * cd /opt/deepstack && set -a && . /etc/deepstack-watcher.env && set +a && npm run -s watch:wallet -- --once >> /var/log/deepstack-watcher.log 2>&1
```

Keep the webhook and heartbeat URLs in `/etc/deepstack-watcher.env` (mode 600), not on the
command line: a value written into the crontab line is visible in `ps` and to anyone who can
read the crontab.

**systemd timer** (a long-running loop works too: `npm run watch:wallet -- --interval 300`):

```ini
# /etc/systemd/system/deepstack-watcher.service
[Service]
Type=oneshot
WorkingDirectory=/opt/deepstack
# webhook URLs, OWNER_ALLOWLIST; chmod 600 (systemd has no trailing comments: keep this on its own line)
EnvironmentFile=/etc/deepstack-watcher.env
ExecStart=/usr/bin/npm run -s watch:wallet -- --once
SuccessExitStatus=2

# /etc/systemd/system/deepstack-watcher.timer
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
```

**GitHub Actions schedule (example only).** This is deliberately **not** committed as a
workflow. On the public repo it would run without the secrets configured, or on forks. To use
it, put it in a private repo or a private fork and add the secrets there. Scheduled runs can be
delayed by several minutes, and the state file has to be carried between runs through the
cache:

```yaml
name: wallet-watcher
on:
  schedule: [{ cron: "*/10 * * * *" }]
  workflow_dispatch: {}
jobs:
  watch:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: actions/cache@v4
        with: { path: watcher-state.json, key: "watcher-${{ github.run_id }}", restore-keys: "watcher-" }
      - run: npm run -s watch:wallet -- --once
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
          WATCH_HEARTBEAT_URL: ${{ secrets.WATCH_HEARTBEAT_URL }}
          OWNER_ALLOWLIST: ${{ secrets.OWNER_ALLOWLIST }}
```

Set the heartbeat check's period and grace to match the schedule (for example a 10-minute
period with a 10-minute grace). The heartbeat is what catches a watcher that has stopped
running entirely.

## Testing alert delivery

```sh
SLACK_WEBHOOK_URL=… WATCH_WEBHOOK_URL=… WATCH_HEARTBEAT_URL=… npm run watch:wallet -- --test-alert
```

This sends one INFO `test-alert` message through every configured channel and pings the
heartbeat once. It prints `sent` or `FAILED` for each channel and exits non-zero if any
channel failed. With no channel configured it prints the message to stdout, marked `DRY-RUN`.

Still pending: a controlled testnet transfer test, in which Matt sends a small testnet STX
transfer from a watched testnet address to a non-allowlisted address and confirms a CRITICAL
`stx-transfer-unlisted` arrives once (pending, then confirmed, with no duplicate). The watcher
cannot run this itself, because it never signs.

## Limitations

- **Agent-originated and attacker-originated calls cannot be told apart.** An attacker
  holding the key who calls an allowlisted router looks like the agent. What still fires is
  any outflow to a non-allowlisted recipient (`transfer-unlisted`), large movements, and
  unexplained balance drops. Allowlisted counterparties (pools) are trusted to return value,
  so a pure value-destroying swap through an allowlisted pool shows up only as
  `large-movement` or `balance-drop`, if it crosses those thresholds.
- **It depends on Hiro.** With no `WATCH_API_FALLBACKS` there is a single provider, and an
  outage triggers `monitoring-failure` rather than silence. `transactions_with_transfers` is a
  deprecated v1 endpoint. If Hiro removes it, the source fails loudly and needs porting to
  `/extended/v2/addresses/{a}/transactions` plus per-tx events.
- **Detection latency is bounded by the poll interval** (plus scheduler delay in CI). Polling
  every 5 minutes catches a pending drain only if it sits in the mempool that long, and on
  Stacks it usually confirms within a block or two. This is detection, not prevention.
- On the first run only the newest 50 txs are baselined. If a poll misses more than
  `WATCH_MAX_PAGES × 50` new txs, `history-gap` fires.
- Dust sent from lookalike addresses (address poisoning, seen in this wallet's history from
  `SP2XQP…8VR2` against the real `SP2X1G…8VR2`) is classified as INFO `incoming`. Never copy
  a destination address out of the tx history.
