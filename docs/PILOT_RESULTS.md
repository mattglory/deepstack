# DeepStack 30-day mainnet pilot — results

*Autonomous liquidity agent on Stacks, Bitflow sBTC-STX (XYK) and sBTC-USDCx (DLMM)
pools. Every figure below is reproducible from the same sources a stranger could check
without trusting this document: the agent's own [journal](../journal/) and
[telemetry](../dashboard/metrics.json), the live [dashboard](https://dashboard-two-alpha-t9c0vbn07m.vercel.app),
and the Stacks explorer for every transaction cited.*

**Status: DRAFT, pilot in progress.** All figures below are current as of **2026-09-25T15:53 UTC** —
day 27.8 of 30. The pilot window closes ~2026-09-27T20:59 UTC. Final numbers will be
refreshed at close before this is submitted as the milestone deliverable; treat the
percentages here as directionally representative, not final. A planned re-add to the
XYK LP position (see Inventory & rebalance activity) is expected 2026-09-26 and will
need one more refresh after it confirms.

## At a glance

| | |
|---|---|
| Pilot window | 2026-08-28T20:59:43Z → (in progress, closes ~2026-09-27T20:59Z) |
| Wallet | `SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60` |
| Uptime | **97%** (1,294 of 1,334 expected heartbeats) |
| Mainnet transactions in-window | **56** (40 confirmed successful, 16 aborted — see Lessons Learned) |
| vs-HODL (IL-adjusted return) | **+0.0%** |
| Portfolio | 4,490.13 → 4,043.87 STX (≈$1,152 → ≈$1,287 at spot STX/USD) |

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
| XYK LP (sBTC-STX) | +2.11 STX | ~606.58 STX | held since pilot start; partial withdraw 2026-09-25 (see below) |
| DLMM (sBTC-USDCx) | -1.27 STX | ~463.48 STX | reopened 2026-09-22 (see incident below); a small negative P&L on a 3-day-old position is normal short-window noise, not a trend — this figure has swung between roughly +47% and -61% annualised on the same underlying position within the last week alone, which is exactly why an APR isn't shown until 3 days of data exist |

Total network fees paid: **11.0 STX** across 40 confirmed transactions.

## IL-adjusted return

**+0.0%** (essentially breakeven) vs holding the exact starting inventory (4,490.13
STX-equivalent basket) untouched since pilot start. This number is deliberately
market-neutral — it does not credit or blame the agent for STX or sBTC's own price
movement, only for whether active management (fees earned, positions rebalanced) beat
passive holding of the same starting assets. sBTC-STX mid ranged from 243,444 to
327,310 STX/sBTC during the window — a genuinely volatile stretch, not a quiet one.
This figure has moved between roughly -1.3% and +4.8% at various points across the
pilot; the number above is a point-in-time snapshot, not a monotonic trend, and the
final submitted figure will be whatever it reads at close.

**Separately, in plain USD terms**, the portfolio moved from ≈$1,152 to ≈$1,287 (+11.7%)
over the same window — mostly STX's own dollar price recovering, not agent skill. These
are two different, both-true statements answering two different questions; don't cite
one to answer the other.

## Uptime

**97%** — 1,294 of 1,334 expected 30-minute heartbeats, over 667 hours of continuous
operation. The gap is almost entirely third-party infrastructure blips (Hiro API rate
limits and transient 503/504s), each self-healing within one 30-minute cycle; see Lessons
Learned for the one real incident.

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

56 mainnet transactions in-window, by function:

| Function | Count | Pool |
|---|---|---|
| `swap-y-for-x` | 18 | sBTC-STX (XYK) |
| `swap-x-for-y` | 3 | sBTC-STX (XYK) |
| `withdraw-liquidity` | 1 | sBTC-STX (XYK) |
| `add-liquidity-multi` | 25 | sBTC-USDCx (DLMM) |
| `withdraw-liquidity-multi` | 9 | sBTC-USDCx (DLMM) |

The XYK sBTC-STX LP position was held continuously since before pilot start, staying
within its target allocation band without needing an adjustment, until a deliberate,
pre-declared partial unwind: tx [`1561040046d7df26c856760624fb4449e8f969ea900c4db8f47e0d6e98ef150c`](https://explorer.hiro.so/txid/0x1561040046d7df26c856760624fb4449e8f969ea900c4db8f47e0d6e98ef150c?chain=mainnet)
(2026-09-25T15:40:31Z, confirmed success), reducing the target LP allocation from 33%
to 15% of portfolio and withdrawing 4.720635 LP tokens for 0.00101259 sBTC + 263.587259
STX. This was declared in writing before the pilot opened — see
[`PILOT_METHODOLOGY.md`](PILOT_METHODOLOGY.md), item 2, "a partial LP unwind in the
final week — demonstrating the exit procedure end-to-end" — not a reaction to this
results post being written. A corresponding partial re-add (methodology item 1) is
planned for 2026-09-26, the day after, so the two remain clearly separate genuine
capital events rather than a same-block round trip.

All other liquidity add/withdraw activity happened on the sBTC-USDCx DLMM position:
1 fresh open, 7 recenters (repositioning the concentrated range as price moved), and
the incident described below.

21 autonomous inventory rebalances (the swaps above) executed on real drift, not
scheduled or manufactured — each with its own logged trigger and, since 2026-09-19,
a timing check that can defer execution up to 6 cycles for a more favorable price
before acting on urgency alone.

## Lessons learned

Two real incidents happened during this pilot. Both are disclosed here in full,
including root cause and fix, because a safety layer is only evidence if it's shown
working under a real failure, not just asserted.

**2026-09-15 — third-party API quota exhaustion.** The Hiro API key hit its plan's
monthly quota, causing read failures on the DLMM position for part of a cycle. On a
warm cache the agent correctly fell back to last-known values; on one cold-cache read
it briefly read a position as zero, which (combined with the read failure) triggered a
withdraw decision that should not have fired. That broadcast failed at the API layer
before reaching the mempool — confirmed independently on-chain, no phantom transaction,
no funds at risk. Fixed same day (API plan upgrade); the underlying "zero on a cold read"
gap was also closed.

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

**General takeaways:**
- Fail-closed design paid for itself twice — both incidents produced a bad *decision*
  at some point, and both times the *execution* layer independently refused to carry
  it out incorrectly. That's not luck; it's why the two layers are separate.
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
