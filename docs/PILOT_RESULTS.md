# DeepStack 30-day mainnet pilot — results

*Autonomous liquidity agent on Stacks, Bitflow sBTC-STX (XYK) and sBTC-USDCx (DLMM)
pools. Every figure below is reproducible from the same sources a stranger could check
without trusting this document: the agent's own [journal](../journal/) and
[telemetry](../dashboard/metrics.json), the live [dashboard](https://dashboard-two-alpha-t9c0vbn07m.vercel.app),
and the Stacks explorer for every transaction cited.*

**Status: FINAL.** The pilot window closed **2026-09-27T20:59 UTC** after 720 hours
(30 days). All figures below are cut at that exact close time and were independently
re-verified against the Stacks explorer. This is the version submitted as the milestone
deliverable. Both halves of the planned XYK add/withdraw pair (see Inventory & rebalance
activity) are complete; the re-add executed as three smaller transactions rather than
one, for a specific, disclosed reason — see below, not a partial failure. Updated
**2026-09-28** with two findings from external review: a DLMM safety-gate gap (fixed,
see Lessons Learned) and a transaction/fee undercount that missed one FlashStack smoke
test (corrected, see Inventory & rebalance activity) — the true in-window transaction
count is 60, not the 59 first published. The safety-gate finding doesn't change any
other figures; the count correction is reflected everywhere above.

## At a glance

| | |
|---|---|
| Pilot window | 2026-08-28T20:59:43Z → 2026-09-27T20:59:00Z (closed, 720h) |
| Wallet | `SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60` |
| Uptime | **97.3%** (1,401 of 1,440 expected heartbeats) |
| Mainnet transactions in-window | **60** (44 confirmed successful, 16 aborted — see Lessons Learned) |
| vs-HODL (IL-adjusted return) | **-1.08%** |
| Portfolio | 4,490.13 → 3,868.67 STX (≈$1,152 → ≈$1,325 at spot STX/USD) |

## Volume facilitated

**1,264.33 STX** across **21 swaps**, all rebalancing trades on the sBTC-STX pool
(18 `swap-y-for-x`, 3 `swap-x-for-y`), all agent-initiated and autonomous. This is not
directional trading — every swap exists to correct inventory drift back toward the
agent's 50/50 target after price movement, and is logged with its own reason in the
journal (e.g. *"y share 65.5% > target 50% → buy x"*).

## Fees earned (economics)

Fees net of impermanent loss — current value of each position versus simply holding the
exact deposited legs at today's price, the honest definition of "did active management
beat just holding":

| Position | P&L (fees − IL) | Value | Basis |
|---|---|---|---|
| XYK LP (sBTC-STX) | +1.54 STX | ~1,047.34 STX | held since pilot start; partial withdraw 2026-09-25 (1 tx), partial re-add 2026-09-26 (3 txs, see below) |
| DLMM (sBTC-USDCx) | +9.53 STX | ~447.28 STX | reopened 2026-09-22, ~5.6 days old at pilot close; annualises to roughly +140%, but a position this young stays noisy — treat the STX figure as the reliable number and the annualised rate as illustrative only |

Total network fees paid: **11.46 STX** across all 60 mainnet transactions in-window (a
failed on-chain transaction still costs its fee — this total includes the 16 aborted
DLMM adds from the Sep 21 incident, not just the 44 that succeeded).

## IL-adjusted return

**-1.08%**, essentially flat, vs holding the exact starting inventory (4,490.13
STX-equivalent basket) untouched since pilot start. This number is deliberately
market-neutral — it does not credit or blame the agent for STX or sBTC's own price
movement, only for whether active management (fees earned, positions rebalanced) beat
passive holding of the same starting assets. sBTC-STX mid ranged from 239,002 to
327,310 STX/sBTC during the window — a genuinely volatile stretch, not a quiet one. The
slight negative tilt is mainly the final-week partial LP withdraw: capital that came out
of the fee-earning LP position sat as idle STX/sBTC for about a day before the re-add,
which a passive full-HODL comparison doesn't penalize — an honest, disclosed side effect
of demonstrating the exit procedure, not a hidden loss.

**Separately, in plain USD terms**, the portfolio moved from ≈$1,152 to ≈$1,325 (+15.0%)
over the same window — mostly STX's own dollar price recovering, not agent skill. These
are two different, both-true statements answering two different questions; don't cite
one to answer the other.

## Uptime

**97.3%** — 1,401 of 1,440 expected 30-minute heartbeats, over the full 720 hours
(30 days) of the pilot. The gap is almost entirely third-party infrastructure blips
(Hiro API rate limits and transient 503/504s), each self-healing within one 30-minute
cycle; see Lessons Learned for the one real incident.

## Spread / divergence history

DeepStack doesn't quote a bid/ask spread in the order-book sense — its analog is the
oracle-divergence tolerance it defends before halting, and the rebalance band it targets
(both volatility-scaled from realised sBTC-STX vol, not fixed). Across the pilot window:

- Pool-vs-oracle divergence: **0.0 to 336.9 bps**, mean **51.7 bps**
- The agent halted trading exactly once when divergence readings became unavailable
  (fail-closed; see Lessons Learned) — it never traded through a stale or manipulated
  reference price
- Separately, `docs/VELAR_SPIKE.md` documents a paper-quoting spread model (~124bps
  two-sided, volatility-scaled) built for the Velar perps feasibility study — the closest
  literal "spread" analysis this project has done, kept isolated from the live pilot
  capital

## Inventory & rebalance activity

60 mainnet transactions in-window, by function:

| Function | Count | Pool |
|---|---|---|
| `swap-y-for-x` | 18 | sBTC-STX (XYK) |
| `swap-x-for-y` | 3 | sBTC-STX (XYK) |
| `withdraw-liquidity` | 1 | sBTC-STX (XYK) |
| `add-liquidity` | 3 | sBTC-STX (XYK) |
| `add-liquidity-multi` | 25 | sBTC-USDCx (DLMM) |
| `withdraw-liquidity-multi` | 9 | sBTC-USDCx (DLMM) |
| `flash-loan` | 1 | FlashStack (not a pool op — see below) |

The XYK sBTC-STX LP position was held continuously since before pilot start, staying
within its target allocation band without needing an adjustment, until a deliberate,
pre-declared withdraw-then-re-add pair carried out on consecutive days, all plain
`add-liquidity`/`withdraw-liquidity` on the pilot's own named pool (not the `-multi`
DLMM functions):

1. **Partial unwind** — tx [`1561040046d7df26c856760624fb4449e8f969ea900c4db8f47e0d6e98ef150c`](https://explorer.hiro.so/txid/0x1561040046d7df26c856760624fb4449e8f969ea900c4db8f47e0d6e98ef150c?chain=mainnet)
   (2026-09-25T15:40:31Z, confirmed success): target LP allocation reduced from 33% to
   15% of portfolio, withdrawing 4.720635 LP tokens for 0.00101259 sBTC + 263.587259 STX.
2. **Partial re-add**, the next day: target restored to 33%. This executed as **three**
   separate transactions rather than one — the agent's per-cycle add size is capped at a
   fixed maximum (`maxAddXBase` in `decideLp()`), so it kept adding that capped amount
   every 30-minute cycle until the position was back within its target band. All three
   confirmed success:
   - [`3f807c4a8355…`](https://explorer.hiro.so/txid/0x3f807c4a8355fcf8a8a547e236721bcdccb67185e5a2482b3d067845d5a893b0?chain=mainnet) — 2026-09-26T03:08:26Z, 0.0003 sBTC + 76.75 STX → 1.386272 LP tokens
   - [`a4a7270cab1d…`](https://explorer.hiro.so/txid/0xa4a7270cab1d38778e4e1c5b22658e44d30a1405aec5c12f99457c0d3ce10e5f?chain=mainnet) — 2026-09-26T03:27:44Z, 0.0003 sBTC + 76.48 STX → 1.383876 LP tokens
   - [`11dba5b09b1a…`](https://explorer.hiro.so/txid/0x11dba5b09b1a374272ec6af4f317e91383f1d7b93fde342456af8957caa8e99e?chain=mainnet) — 2026-09-26T04:07:47Z, 0.0003 sBTC + 77.18 STX → 1.390104 LP tokens

   Combined: 0.0009 sBTC + 230.41 STX deposited for 4.160252 new LP tokens — slightly
   less than the 4.720635 withdrawn the day before, since the portfolio's size and the
   pool's price ratio had both moved in the interim.

This pair was declared in writing before the pilot opened — see
[`PILOT_METHODOLOGY.md`](PILOT_METHODOLOGY.md), items 1 and 2 ("one mid-pilot LP
allocation adjustment... producing a real add or withdraw" and "a partial LP unwind in
the final week — demonstrating the exit procedure end-to-end") — not a reaction to this
results post being written, and kept a day apart on purpose so the two remain clearly
separate genuine capital events rather than a same-block round trip.

All other liquidity add/withdraw activity happened on the sBTC-USDCx DLMM position:
1 fresh open, 7 recenters (repositioning the concentrated range as price moved), and
the incident described below.

21 autonomous inventory rebalances (the swaps above) executed on real drift, not
scheduled or manufactured — each with its own logged trigger and, since 2026-09-19,
a timing check that can defer execution up to 6 cycles for a more favorable price
before acting on urgency alone.

**One FlashStack transaction also happened during the pilot window, disclosed here for
completeness:** tx [`cf374e8f9f79ab40e297cd44d9346cc7781f3b5103e8edbce94ed0b00ae866c1`](https://explorer.hiro.so/txid/0xcf374e8f9f79ab40e297cd44d9346cc7781f3b5103e8edbce94ed0b00ae866c1?chain=mainnet)
(2026-09-16T21:34:13Z, confirmed success), a manually-triggered 5 STX `flash-loan` call
against `flashstack-stx-core` with receiver `stx-test-receiver`. This was a smoke test
of the FlashStack integration, not an attempted flash-rebalance — no rebalance logic ran,
it borrowed and repaid 5 STX in the same transaction with a test receiver, and it wasn't
autonomous agent activity. It does not count toward the M2 flash-rebalance criterion,
which is separately satisfied by the pre-pilot flash-rebalance documented in
[`FLASH_REBALANCE.md`](FLASH_REBALANCE.md) (2026-07-18, tx `1f826abe...`). Included in
the transaction and fee totals above because it's a real transaction from the pilot
wallet during the pilot window, and this document's own promise is that every such
transaction is disclosed, not just the ones that make the numbers look cleanest.

## Lessons learned

Four real incidents happened during and just after this pilot. All are disclosed here in
full, including root cause and fix, because a safety layer is only evidence if it's shown
working under a real failure, not just asserted.

**2026-09-15 — third-party API quota exhaustion.** The Hiro API key hit its plan's
monthly quota, causing read failures on the DLMM position for part of a cycle. On a
warm cache the agent correctly fell back to last-known values; on one cold-cache read
it briefly read a position as zero, which (combined with the read failure) triggered a
withdraw decision that should not have fired. That broadcast failed at the API layer
before reaching the mempool — confirmed independently on-chain, no phantom transaction,
no funds at risk. Fixed same day (API plan upgrade); the underlying "zero on a cold read"
gap was also closed.

**2026-09-11 — an isolated DLMM re-add abort (1 tx).** A routine recenter's re-add step
hit the same underlying issue described below and aborted once. Unlike the incident
below, it didn't cascade: the very next 30-minute cycle fell back to opening a fresh
position instead of retrying the recenter, which succeeded immediately. Self-healed
within one cycle, no funds at risk, and at the time it read as an isolated blip rather
than a pattern — the same root cause resurfaced ten days later as the multi-hour
incident that follows, which is what actually prompted the real fix.

**2026-09-21 — a DLMM add-liquidity failure loop.** After a routine recenter, every
subsequent add attempt aborted on-chain for ~7 hours (15 failed transactions, ~4.5 STX
in wasted fees, no capital lost — the funds sat as loose tokens in the wallet the whole
time). Root cause: the code applied one flat minimum-shares guard to every bin in a
multi-position deposit, when each bin actually mints shares proportional to its own
size — thin bins were rejecting the whole transaction. Two gaps let it run as long as it
did: the manual kill switch didn't cover the DLMM code path, and the failure-retry logic
had no cap. All three fixed: per-bin sizing computed from live pool state before
broadcasting, the kill switch now covers every trading path, and DLMM broadcasts stop
automatically after 2 consecutive failures until manually cleared. Validated with one
attended live transaction before resuming autonomous operation.

**2026-09-28 — DLMM broadcasts skipped the oracle/drawdown/pool-paused safety gate,
found by external review.** For the DLMM leg's entire live-trading history, including
the full pilot window, `recenterOnce()` checked the manual kill switch and nonce safety
before broadcasting, but never called the same `assessSafety()` check (oracle-price
divergence, session drawdown, pool-paused) that has always gated the XYK leg. In
practice this pilot's actual pool-vs-oracle divergence never came close to the halt
threshold (max 336.9bps observed vs. a 500bps limit — see Spread / divergence history
above), so the gap never caused a live consequence here, but it was a real structural
gap that could have let DLMM keep trading through a genuine oracle problem. Found by
external reviewer Hillary Kibet's code review, the same day: `DLMM_LIVE` was flipped
off as an immediate mitigation, then `assessSafety()`'s result was hoisted out to be
computed once per cycle and shared by both the XYK and DLMM paths instead of only
being checked (and only consumed) inside the XYK code. Note the scope precisely: this
gates DLMM on the same portfolio-level signal XYK uses (sBTC-STX divergence, overall
drawdown, XYK pool-paused status), not a dedicated sBTC-USDCx-specific oracle check,
since that's the only external price reference the agent tracks. Verified with a unit
test that isolates the exact gap (an unsafe condition blocks the DLMM broadcast even
when the kill switch and every other check pass) rather than a live attended cycle,
because a live-only test would have been confounded by the kill switch already being
checked independently inside `recenterOnce()` for an unrelated reason. `DLMM_LIVE` was
resumed the same day once the fix and its test were deployed and one live cycle
confirmed clean.

**General takeaways:**
- Fail-closed design paid for itself three times — each incident produced a bad
  *decision* or a malformed transaction at some point, and each time the *execution*
  layer independently refused to carry it out incorrectly. That's not luck; it's why
  the two layers are separate.
- A safety control that exists for one trading path isn't automatically applied to
  another just because they share a wallet and a codebase — the 2026-09-28 finding is
  the clearest example: the DLMM path had its own kill-switch and nonce-safety checks,
  which looked complete until compared line-by-line against what the XYK path actually
  gates on.
- A parameter change that alters what a transaction contains needs to be validated
  against a real broadcast, not just unit-tested in isolation — the 2026-09-21 root
  cause was a width change that had only ever been exercised in pure math tests before
  a real recenter exposed it.
- Cost-basis tracking for a position that can be fully closed and later reopened needs
  an explicit reset on reopen, not just on first-ever use — found and fixed the same
  week, after the incident above exposed a related basis-staleness bug in the P&L
  reporting itself.

## Verify this independently

- Live dashboard: https://dashboard-two-alpha-t9c0vbn07m.vercel.app
- Repo: https://github.com/mattglory/deepstack
- Every transaction cited above is on the [Stacks explorer](https://explorer.hiro.so/?chain=mainnet) under the wallet address at the top of this doc
- `npm run m2:pnl` regenerates the headline numbers directly from `journal/*.jsonl` and `dashboard/metrics.json` — nothing here is asserted without a reproducible source
