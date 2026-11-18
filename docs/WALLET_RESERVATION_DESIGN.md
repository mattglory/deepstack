# Per-venue token reservation: design

*Status: design only, for review before code. Written 2026-11-18. Prerequisite for
capital-preservation mode (#90, finding R90-2) and for any second DLMM pair (#89, R89-1/R89-2).*

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
| DLMM pair P, re-add pending | exactly the pending x and y | `dlmm-pending-readd[.P].json` (exists today) |
| DLMM pair P, leftovers | what P withdrew but did not re-add | new `dlmm-leftover[.P].json`, written by the re-add / open |
| Capital-preservation mode | its sBTC and USDCx holding, and a pending switch | `trend-state.json` (its design) |
| XYK | **the unclaimed remainder**: no file | everything else |

The XYK remains the residual owner, as today. Owner deposits arrive unclaimed and so go to the
XYK, which is today's behaviour; anything else is an attended allocation.

## 3. Rules

1. **Pure and in one place.** `allocate(walletBalances, claims) -> { available per venue per token, problems }`
   in a new `src/m1/reservation.ts`, unit-tested. Every step calls it at the start of its cycle.
2. **Fail closed on over-claim.** If, for any token, the claims exceed the wallet balance (beyond a
   dust tolerance for indexer lag, e.g. 0.5% or 1 base unit), nothing trades that token this cycle,
   the cycle alerts, and the problem is journalled. That is what an external transfer, a missed
   confirmation or a bug looks like, and it needs a human.
3. **Fail closed on unreadable claim files**, as #55 and #95: a claim file that exists but cannot be
   read means that venue's claim is unknown, so no other venue may trade its tokens.
4. **Atomic writes**, as `dlmm-pending-state` (temp file and rename).
5. **Leftovers.** After a re-add or open, the DLMM writes what it withdrew and did not deposit as its
   leftover claim; its next add includes them, and then the claim is cleared. Decision for review: keep
   them with the DLMM indefinitely, or release them to the XYK after N cycles?
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
| Gas | 50 STX (XYK), 100 STX (DLMM) | one `STX_GAS_RESERVE` (proposal: 50 STX) |

## 5. Rollout

1. **Shadow mode.** Build `reservation.ts` and log, every cycle, the claims and what each venue
   *would* see, next to what it actually used. No behaviour change. At least a week, including one
   DLMM recenter.
2. **Enforce for the XYK step.** It sizes from `available(xyk, ·)`. The #91/#95 hold stays.
3. **Enforce for the DLMM** (open and leftovers), and unify the gas reserve.
4. Only then: capital-preservation observe mode (#90), and any extra pair (#89), each registering its
   own claim.

## 6. Tests

- Pure: allocation with no claims (= today), with each claim type, over-claim and dust, unreadable file.
- Fault harness (#66): replay the 2026-11-14/15 incident; the XYK step must see 0 of the re-add's sBTC.
- Recenter leftovers stay with the DLMM and go into its next add, not the XYK.
- A DLMM open never takes the XYK's spare sBTC.
- An external transfer out of the wallet produces an over-claim: no trading of that token, and an alert.

## 7. Questions for review
1. Leftovers: keep with the DLMM until its next add, or release to the XYK after N cycles?
2. Dust tolerance for over-claim: a percentage, a fixed number of base units, or both?
3. One `STX_GAS_RESERVE`: 50 STX enough for the DLMM recenter path (about 1.5 STX per recenter)?
4. Should owner deposits stay unclaimed (XYK), or default to a separate "owner" claim that only an
   attended command allocates?
