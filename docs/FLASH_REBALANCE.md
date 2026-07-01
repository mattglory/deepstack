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

1. **Receiver contract / call path** — DeepStack invokes FlashStack's flash-loan entry
   point with a receiver that performs the rebalance and repays in-transaction.
   *(Verify FlashStack's current flash-loan function signature + receiver interface from
   the FlashStack repo before coding — same discipline as the Bitflow adapter.)*
2. **Guards carry over** — the same input-cap post-conditions, on-chain min-output guards,
   and the oracle-sanity + kill-switch gate wrap the flash-rebalance path.
3. **Deliverable** — **≥1 live FlashStack flash-rebalance transaction on mainnet**, linked
   in the M2 submission, demonstrating the DeepStack→FlashStack fee flow end-to-end.

## Honest framing for reviewers

- **Today:** direct-swap rebalancing (live, validated).
- **M2:** first live flash-loan rebalance via FlashStack (committed deliverable).
- **At scale:** flash-loan rebalancing is the default, making DeepStack capital-efficient
  and turning every rebalance into FlashStack fee revenue.

This is the technical basis for "DeepStack is FlashStack's first production customer" —
stated as a design + committed milestone, not as something every current rebalance does.
