# DeepStack ↔ FlashStack: flash-loan-powered rebalancing

*How DeepStack routes inventory rebalancing through FlashStack flash loans — the
mechanism behind the "DeepStack is a FlashStack customer" flywheel. Honest about
current state vs the M2 deliverable.*

## Current state (today)

DeepStack's live agent rebalances with **direct swaps** on the Bitflow sBTC-STX pool
(`swap-x-for-y` / `swap-y-for-x`), validated on mainnet (tx `cedda90…caa0b`). This is
the correct, simplest mechanism for the ~$1K pilot and does **not** use flash loans.

## Why flash loans (the capital-efficiency case)

A direct swap requires the agent to already hold the inventory it moves. That caps how
much depth a given amount of capital can manage. FlashStack flash loans remove that cap:
the agent borrows atomically, rebalances, and repays **in one transaction** — so it can
manage a larger position or rebalance without pre-holding idle capital. On every such
rebalance, FlashStack earns its **0.05% fee**, which accrues to FlashStack LPs. That is
the flywheel: **DeepStack volume → FlashStack fees → LP yield → deeper reserves → more
DeepStack capacity.**

Flash-loan rebalancing is most valuable **at scale** (managing large LP positions
capital-efficiently), not for tiny pilot swaps — so it is introduced as a demonstrated
capability, then leaned on as capital grows.

## The atomic flow (one transaction)

```
DeepStack agent decides: rebalance X of asset A -> B
   │
   ├─ 1. flash-borrow  A  from FlashStack            (FlashStack.flash-loan)
   ├─ 2. execute the rebalance on the venue          (Bitflow swap / LP adjust)
   ├─ 3. repay  A + 0.05% fee  to FlashStack          (atomic, same tx)
   └─ if repayment would fail  ->  whole tx reverts   (no partial state, no risk)
```

FlashStack's design guarantees atomicity: if the borrowed amount + fee is not repaid
within the transaction, the entire transaction reverts. So a flash-rebalance can never
leave DeepStack under-collateralised or FlashStack short — it either completes whole or
does nothing (losing only the network fee).

## Implementation plan (DeepStack M2 deliverable)

1. **Sizing core — DONE (`src/m1/arb.ts`).** Given pool reserves and the external
   reference mid, the closed-form optimal divergence-capture trade with pool fee,
   FlashStack fee (5bps), and gas netted out. The agent journals every detected
   opportunity each cycle (`"arb"` entries, detection only) — by pilot end this is a
   measured record of how much capturable edge actually existed, the honest counterpart
   to the LVR estimate in `src/m1/lvr.ts`.
2. **Receiver contract / call path — interface VERIFIED from FlashStack source**
   (github.com/mattglory/Flashstack, read 2026-07-17):
   - Entry point: `flashstack-stx-core.flash-loan(amount uint, receiver <stx-flash-receiver-trait>)`.
   - Receiver implements `(execute-stx-flash (uint principal) (response bool uint))` from
     `SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait`; the core
     transfers the STX first, invokes the callback, then asserts its reserve grew by ≥ fee.
   - Fee: `fee-basis-points` (default 5bps, floor 1 µSTX), read on-chain — matches
     `FLASH_FEE_BPS` in `src/m1/arb.ts`.
   - **Receivers are whitelisted** (`approved-receivers` map, owner-set): the DeepStack
     receiver must be approved on the core after deployment.
   - Template: `bitflow-arb-receiver.clar` (STX→stSTX→STX round-trip on a Bitflow
     stableswap) is the closest working pattern. One discipline difference for DeepStack:
     the template uses `min-out = u1` legs and relies on the repay assert as its only
     gate; the DeepStack receiver should carry real min-outs quoted from `get-dy`/`get-dx`,
     same as every other DeepStack transaction.
   - **Second-leg answer (rebalance case):** the core invokes the callback *outside*
     `as-contract`, so inside the receiver `tx-sender` is still the agent wallet. The
     receiver can therefore repay from the agent's own inventory
     (`stx-transfer? shortfall tx-sender core`) — borrow STX, buy sBTC in the pool at a
     size larger than free inventory, repay from inventory + proceeds. Own-inventory IS
     the second leg for a market maker; no second venue required for the rebalance
     deliverable. (Cross-venue capture — e.g. via `multidex-arbitrage-receiver.clar` —
     remains the later, at-scale path.)
3. **Guards carry over** — the same input-cap post-conditions, on-chain min-output guards,
   and the oracle-sanity + kill-switch gate wrap the flash-rebalance path.
4. **Deliverable — DELIVERED (2026-07-18).** First live flash-rebalance executed on mainnet:
   tx `1f826abe4668f3c8f04b93d0113d1e00b1f52280fa0fff285b8be02e4878b097` (block 8579338).
   One atomic transaction: core lent 10 STX → receiver swapped via the Bitflow pool with the
   armed min-out enforced → all sBTC forwarded to the operator → operator repaid 10.005 STX.
   The FlashStack reserve grew by the 5bps fee — the DeepStack→FlashStack fee flow, live.
   Receiver: `SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60.deepstack-rebalance-receiver`
   (deploy tx `940af115…e7fe2`); ops CLI: `npm run m2:receiver`.

Note the atomicity constraint on *capture*: a flash-borrowed input must be repaid in the
same transaction, so converting detected edge into profit needs a second leg in that
transaction (another pool, or the agent's own inventory acting as the counter-side). The
detector deliberately stays venue-agnostic; the journal tells us whether the edge is worth
building the second leg for.

## Routing decision, October 2026: flash route paused until it adds capacity

**What we measured.** Four autonomous flash rebalances ran on mainnet between 2026-10-07 and
2026-10-08, sized 51.7 to 75.3 STX, all successful. Each cost two network fees (arm + loan,
0.10 STX) plus FlashStack's 0.05% fee, about **0.08 STX more than one direct swap** of the same
size (0.05 STX). Total extra over the four: 0.33 STX.

**Why the route is paused.** The deployed receiver repays the loan from the agent's own STX,
and the executor caps each loan at that STX. So a flash rebalance could never move more than a
direct swap funded by the same STX. In practice it:
- added cost and a second transaction that can fail;
- raised the per-trade limit for buying sBTC from 50 STX (`maxSwapYBase`) to 150 STX
  (`FLASH_MAX_SWAP_Y_BASE`) for exactly the same market risk, a risk limit bypassed by routing;
- generated FlashStack volume and fees funded entirely by our own capital, which is activity
  rather than real usage and should not be presented as customer demand.

**What runs now.** `FLASH_RECEIVER_ADDS_CAPACITY = false` in `src/m1/agent.ts`. A purchase over
the 50 STX cap is done as a capped direct swap, with the remainder on later 30-minute cycles.
In a thin pool, splitting a large trade is also the gentler execution. The flash code path,
receiver contract and manual CLI stay in place. The proven 2026-07-18 flash rebalance and the
milestone evidence are unaffected.

**When it comes back: a receiver that adds capacity.** A flash loan beats a direct swap only
when the repayment comes from somewhere other than the agent's own STX. Two credible designs:

1. **Cross-venue arbitrage leg (recommended first).** Borrow STX, buy sBTC on the venue where
   it is cheap, sell it on the venue where it is rich, repay, keep the edge. No own capital is
   needed, and buying on the cheaper Bitflow pool pushes its price toward the market, which also
   helps the LP position. Preconditions:
   - a second sBTC/STX venue with real depth and a callable swap (candidates: the Bitflow
     HODLMM sBTC pools, ALEX; Velar spot only, never Velar perps while that gate holds);
   - the detector's journal (`arb.ts`, already logging net edges such as 0.24 STX at 0.88%
     divergence) showing edges that clear both pool fees, the 0.05% loan fee and two network
     fees often enough to matter;
   - a receiver with real minimum outputs on both legs, an independent review, and a testnet
     run before mainnet.
2. **Atomic position migration.** Use a loan to move liquidity between pools or ranges in one
   transaction without pre-holding idle capital. Valuable only at a scale well beyond the pilot.

Do not re-enable the autonomous route with a receiver that repays from own inventory.

## Honest framing for reviewers

- **Today:** direct-swap rebalancing (live, validated).
- **M2:** first live flash-loan rebalance via FlashStack (committed deliverable).
- **Paused (October 2026):** the autonomous flash route, because the current receiver adds no
  capacity over a direct swap (see the routing decision above).
- **At scale:** flash loans with a capacity-adding receiver (a cross-venue leg), which is what
  makes rebalancing genuinely capital-efficient and FlashStack fees genuine usage.

This is the technical basis for "DeepStack is FlashStack's first production customer" —
stated as a design + committed milestone, not as something every current rebalance does.
