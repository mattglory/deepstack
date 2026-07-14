# DeepStack Safety Controls

*The complete safety layer: what each control does, where it lives in code, and the
live on-chain evidence that it works. DeepStack's design premise is that the agent
must be safer than the venues it trades on — every control below is deterministic,
none can be modified by the AI layer, and the system fails closed.*

## Summary table

| # | Control | Code | Live evidence |
|---|---|---|---|
| 1 | Input-cap post-conditions | `src/m1/actions.ts` | Mainnet swap `cedda90…caa0b` (success); Deny-mode abort `95b112e1…f7d0` (fail-closed proof) |
| 2 | Fresh on-chain min-output guards | `src/m1/quotes.ts`, `src/m1/actions.ts` | Swap received exactly the quoted output — `(ok u1411)` |
| 3 | Slippage protection | `src/m1/quotes.ts` | All min/max args derived from fresh quotes ± tolerance; never `min = 0` |
| 4 | Transaction size caps | `src/m1/agent-cli.ts`, `src/m1/smoke-cli.ts`, `src/m1/agent.ts` | Hard ceilings enforced pre-broadcast; refusals logged |
| 5 | Oracle sanity check | `src/m1/safety.ts` | Live runs: pool-vs-external divergence 0.07–0.70%, SAFE verdicts; halts beyond 5% band |
| 6 | Kill switch + drawdown halt | `src/m1/safety.ts` | Verified live: `⛔ SAFETY HALT — manual kill-switch engaged (no trading this cycle)` |

## 1. Input-cap post-conditions

Every write transaction carries Stacks **post-conditions** capping what the sender can
send — the agent can never overspend, regardless of any bug elsewhere. Native STX legs
use `willSendLte(...).ustx()`, SIP-010 legs use `.ft(...)`; the builder branches on the
token type per pair (`sendCapPC()` in `src/m1/actions.ts`).

**Why Allow-mode + input caps (not Deny-mode receive assertions):** validated on
mainnet. A first Deny-mode attempt aborted with `abort_by_post_condition` while the
contract logic itself succeeded (`(ok u1411)`) — the on-chain events showed the pool
(not the core contract) sends the output token, plus a separate protocol-fee transfer.
The transaction **failed closed**: no funds moved, only the network fee was spent.
That abort is itself evidence the guard works. The corrected model — strict input caps
plus the contract's on-chain minimum-output arguments — then succeeded end-to-end.

- Failed-closed abort: `0x95b112e1a49f1ab1fabbe53f091ed9abfd3de6177beac02fa6b17fe6cf95f7d0`
- Successful validated swap: `0xcedda9095a297c5b7749fcb8fcf2c02e5589aa78978d8fc3717c9369d29caa0b`
  (5 STX → 0.00001411 sBTC, exactly the pre-trade quote)

## 2. Fresh on-chain min-output guards

Every write includes the contract's own minimum-output argument (`min-dlp`, `min-dy`,
`min-dx`, `min-x-amount`, `min-y-amount`), sized from a **fresh read-only quote**
(`get-dlp` / `get-dy` / `get-dx`, `src/m1/quotes.ts`) taken immediately before signing.
If execution would deliver less than the guarded minimum, the contract itself reverts
the transaction. The validated swap received precisely the quoted amount.

## 3. Slippage protection

`minusSlippage()` / `plusSlippage()` (`src/m1/quotes.ts`) apply a basis-point tolerance
(default 100 bps) to every quote: floors on amounts received, ceilings on amounts sent.
A transaction is **never** submitted with a zero minimum. The tolerance is an AI-tunable
parameter — but clamped to 10–300 bps (see §7).

## 4. Transaction size caps

Two independent layers:
- **Hard ceilings** (code constants, never configurable at runtime): e.g. 25 STX /
  0.0005 sBTC per smoke or agent transaction (`CAP_*` in `src/m1/agent-cli.ts`,
  `src/m1/smoke-cli.ts`). Balance and fee-headroom checks run before every broadcast.
- **Parameter caps** (`maxSwapYBase`, `maxSwapXBase`, `maxAddXBase`,
  `maxWithdrawLpBase` in `src/m1/agent.ts`): bound every decision the agent sizes.

Violations are refused pre-broadcast and logged with the reason.

## 5. Oracle sanity check (`src/m1/safety.ts`)

Designed in direct response to the February 2026 Velar PerpDEX oracle-manipulation
exploit: **the agent never trusts a single price source.** Before any trade, each cycle:

1. Reads the pool's on-chain mid from live reserves.
2. Fetches an **independent reference price** (CoinGecko) for the pair's two assets.
3. Computes divergence; if it exceeds a band (default 5%), trading **halts** — a
   diverging pool price during thin volume is the signature of manipulation.
4. **Fails closed**: if the external reference is unavailable, the agent does not trade.
5. Also honours the venue's own `pool-status` flag (paused pool → no trading).

Live output (observe mode): divergences of 0.07%–0.70% against the 5% band, SAFE
verdicts; the assessment line is printed and journaled every cycle.

## 6. Kill switch and drawdown halt (`src/m1/safety.ts`)

- **Manual kill switch**: setting `KILL_SWITCH=1` or creating a `KILL` file halts all
  trading immediately — verified live:
  `⛔ SAFETY HALT — manual kill-switch engaged (no trading this cycle)`.
- **Session drawdown limit**: if portfolio value drops more than a configured fraction
  (default 15%) from the session baseline, trading halts automatically.

## 7. Defense in depth (surrounding rails)

- **Live trading is double opt-in**: `--live` *and* `--yes-mainnet` flags; observe mode
  is the default and broadcasts nothing.
- **AI layer cannot weaken safety**: the LLM (OpenRouter) only proposes parameters;
  every value is clamped to fixed ranges (band 1–20%, slippage 10–300 bps, target split
  0.3–0.7), **hard caps are never AI-settable**, and any error falls back to safe
  defaults (`src/m1/ai/tune.ts`). The LLM never signs or sizes a transaction.
- **Confirmation polling**: after each broadcast the agent waits for on-chain
  confirmation before the next cycle — no double-trading on stale balances
  (`waitForTx`, `src/m1/agent-cli.ts`), capped by `--max-trades` per run.
- **Key handling**: the signing key/seed is read only from a gitignored `.env`, never
  logged, never committed; dry-run builders sign with ephemeral random keys.
- **Audit trail**: every cycle appends a decision record (observation, safety verdict,
  decision + reasoning, AI tune events, transaction outcome) to a JSONL journal
  (`src/m1/journal.ts`), and heartbeat/price/inventory telemetry to the public
  dashboard's `metrics.json` (`src/m1/metrics.ts`).
- **Liveness alerting**: optional dead-man's-switch ping (`HEALTHCHECK_URL`) every
  cycle — missed pings alert the operator within minutes.

## Verify it yourself

```bash
npm run m1:safety                    # live oracle-sanity verdict for the active pair
KILL_SWITCH=1 npm run m1:agent       # kill switch halts the cycle
npm run m1:dryrun                    # inspect post-conditions + min-guards, no broadcast
```

Both referenced mainnet transactions are publicly verifiable on the Hiro explorer.
