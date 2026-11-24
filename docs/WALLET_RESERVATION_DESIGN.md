# Per-venue token reservation: design

*Status: reviewed 2026-11-24 (answers in section 7 adopted below). Stage 1 (shadow) is live (#102,
#107). Written 2026-11-18. Prerequisite for capital-preservation mode going live (#90, finding R90-2)
and for any second DLMM pair (#89, R89-1/R89-2).*

## 1. The problem

The XYK position, the primary DLMM position and (later) capital-preservation mode and extra DLMM
pairs all trade from **one wallet**. Each step sizes its trades from the wallet's balances, and
nothing records which loose tokens belong to which venue.

| Case | What happens today | Seen |
|---|---|---|
| A pending DLMM re-add's tokens | The XYK step reads them as its own inventory and trades them | 2026-11-14/15 incident: ~0.019 sBTC of a 0.041 sBTC re-add went into the XYK pool and STX |
| DLMM recenter leftovers (the 2% held back, any amount above the cap) | Loose; the XYK step absorbs them | Every recenter, e.g. 7 XYK adds on 2026-11-16 |
| A DLMM `open` | Sized from the whole wallet, so it can take the XYK's spare sBTC | Possible on every open |
| Capital-preservation switches (planned) | Would size from the same balances | Design blocker R90-2 |
| An extra DLMM pair (parked) | Its pending tokens are STX and sBTC, exactly the XYK's | R89-1 |
| Gas | Two different STX reserves: XYK 50 STX, DLMM 100 STX | Inconsistent |

Today's guards are stopgaps: #91 makes the XYK step hold while a primary re-add is pending, and #95
makes it hold if that file is unreadable. They cover one case, for one pair.

## 2. Principle: claims derived from each venue's own durable state

No separate running ledger of balances, which would drift from the chain. Instead, each venue
**declares a claim** on loose tokens from the state it already persists, and every step sizes only
from what is left:

```
available(venue, token) = wallet(token) - gasReserve(token) - Σ claims of the OTHER venues on token
```

| Claimant | Claim (loose tokens it owns) | Derived from |
|---|---|---|
| Gas reserve | STX only, one value for every step | `STX_GAS_RESERVE` (replaces the 50 / 100 STX pair) |
| Owner, unallocated | a recorded owner deposit, until an attended command allocates it | `capital-flows.json` entries made with the capital-flow CLI |
| DLMM pair P, re-add pending | exactly the pending x and y | `dlmm-pending-readd[.P].json` (exists today) |
| DLMM pair P, leftovers | what P withdrew but did not re-add | new `dlmm-leftover[.P].json`, written by the re-add / open |
| Capital-preservation mode | its sBTC and USDCx holding, and a pending switch | `trend-state.json` (its design) |
| XYK | **the unclaimed remainder**: no file | everything else |

The XYK remains the residual owner, as today. A **recorded** owner deposit becomes an "owner,
unallocated" claim that only an attended command allocates to a venue. Without a ledger the agent
can't tell an unrecorded inflow from the XYK's own gains, so an unrecorded inflow stays residual
(XYK) as today, but one above a threshold alerts: it is a forgotten record or something unexpected.

## 3. Rules

1. **Pure and in one place.** `allocate(walletBalances, claims) -> { available per venue per token, problems }`
   in a new `src/m1/reservation.ts`, unit-tested. Every step calls it at the start of its cycle.
2. **Fail closed on over-claim.** If, for any token, the claims exceed the wallet balance beyond a
   rounding tolerance of `max(10 bps, 1 base unit)`, **no venue** trades that token this cycle (#107),
   and the problem is journalled. That is what an external transfer, a missed confirmation or a bug
   looks like, and it needs a human. **Lag is handled separately from rounding:** right after the
   agent's own confirmed transaction a read can be a whole transaction behind, so an over-claim in the
   first cycle after our own transaction skips that token without alerting; the alert fires only if it
   is still there the next cycle. Reading every balance at one chain tip (#111) removes most of it.
3. **Fail closed on unreadable claim files**, as #55 and #95: a claim file that exists but cannot be
   read means that venue's claim is unknown, so no other venue may trade its tokens.
4. **Atomic writes**, as `dlmm-pending-state` (temp file and rename).
5. **Leftovers.** After a re-add or open, the DLMM writes what it withdrew and did not deposit as its
   leftover claim; its next add includes them, and then the claim is cleared. **They stay with the DLMM;
   there is no release on a timer** (a timed release recreates the 11-14 case whenever a re-add stalls
   longer than N cycles). The claim lapses only (a) when the DLMM has no position and no pending
   re-add, so the tokens fall to the residual owner, or (b) by an attended command. When leftovers move
   to the XYK, it is recorded as a transfer in both venues' basis, so each venue's P&L stays right.
6. **Positions are not loose tokens.** LP tokens and DLMM bin shares are already separated by
   contract; the reservation covers only fungible tokens sitting loose in the wallet.
7. **Attended commands** (the manual recenter CLI, rotations, owner withdrawals) run with KILL
   engaged, as they do now. The CLI reads the same claims and refuses to spend another venue's tokens
   unless given an explicit override, logged.

## 4. What changes, step by step

| Step | Today | With reservation |
|---|---|---|
| XYK inventory (`readMarket`) | free = wallet sBTC/STX | free = `available(xyk, ·)`; `portfolioY` still counts everything |
| XYK hold (#91/#95) | holds while a primary re-add is pending | kept until the reservation is proven, then redundant |
| DLMM open | sized from the whole wallet | sized from `available(dlmm P, ·)` = its leftovers + unclaimed tokens, capped by its target |
| DLMM re-add | sized from pending amounts, capped by balance | unchanged; writes its leftover claim afterwards |
| Trend mode | (not built) | sizes switches from its own claim only |
| Gas | 50 STX (XYK), 100 STX (DLMM) | one `STX_GAS_RESERVE` = 50 STX. Alert when free STX is under 2x the reserve. Before a recenter's withdraw, require the reserve to cover a full recenter at 10x today's fee, so a withdraw can never strand tokens it can't afford to re-add |

## 5. Rollout

1. **Shadow mode.** *Done: live since 2026-11-18 (#102), over-claim fix #107.* Logs, every cycle, the
   claims and what each venue *would* see, next to what it actually used. No behaviour change. It caught
   the 2026-11-21 recenter correctly: the XYK would have sized from 0.0444 sBTC, the reservation limits
   it to 0.00093.
2. **Enforce for the XYK step.** It sizes from `available(xyk, ·)`. The #91/#95 hold stays.
3. **Enforce for the DLMM** (open and leftovers), and unify the gas reserve.
4. Only then: capital-preservation **live** mode (#90; observe mode holds nothing and was built first,
   #104), and any extra pair (#89), each registering its own claim. `pendingReaddClaims` takes the
   list of pairs once there is more than one (R101-2).

## 6. Tests

- Pure: allocation with no claims (= today), with each claim type, over-claim and dust, unreadable file.
- Fault harness (#66): replay the 2026-11-14/15 incident; the XYK step must see 0 of the re-add's sBTC.
- Recenter leftovers stay with the DLMM and go into its next add, not the XYK.
- A DLMM open never takes the XYK's spare sBTC.
- An external transfer out of the wallet produces an over-claim: no trading of that token, and an alert.

## 7. Review answers (2026-11-24, adopted above)

1. **Leftovers** stay with the DLMM until its next add, never released on a timer; released only when
   the DLMM has nothing open or pending, or by an attended command, and recorded as a basis transfer
   (rule 5).
2. **Tolerance:** rounding `max(10 bps, 1 unit)`; lag handled by a one-cycle grace after our own
   transaction, alerting only if it persists, and by single-tip reads (#111) (rule 2, R101-3).
3. **Gas:** 50 STX is enough. Measured on the new wallet: 0.30 STX per DLMM router call, 0.05 STX per
   XYK call, about 1.2 to 2.1 STX per recenter. Plus the 2x alert and the pre-withdraw check (section 4).
4. **Owner deposits:** an "owner, unallocated" claim for recorded deposits only, allocated by an attended
   command; an unrecorded inflow above a threshold alerts (section 2).
