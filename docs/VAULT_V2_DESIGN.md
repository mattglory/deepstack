# DeepStack Vault v2: design note

Status: draft for review, 2026-10-08. No Clarity code has been written. This note answers the
independent review of v1 (2026-10-07: C1, H1-H3, M1, M2, L1-L5, I1) and the reviewer's design
notes of 2026-10-08. Values marked **[confirm]** are recommendations awaiting the owner's
decision.

## 1. Goals and non-goals

v2 must make each review finding impossible by construction, not by operator discipline:

- The trading agent's hot key can never move vault funds (C1).
- Nobody can be priced at a stale value: every deposit or exit made while capital is out
  settles at the price after that capital returns (H3).
- Exits are always possible in bounded time and a parameter change can never land while
  depositors are locked in (H1, H2).
- The fee is fair per share (M1), exact (L1), and every state change is visible (L3).

Non-goal: a fully non-custodial strategy. The strategy is still a wallet the agent trades
from, so the contract cannot verify what happens to deployed capital or force it back. v2
bounds that trust (section 6); removing it needs a strategy contract restricted to approved
pools, which is later, separate work.

## 2. Roles

| Role | Principal | Can do | Cannot do |
|---|---|---|---|
| Admin | Native Stacks 2-of-3 multisig **[confirm]** | Queue/confirm parameter changes, sweep to strategy, unpause, queue admin change | Return capital, bypass the timelock, touch settled payouts |
| Strategy | One fixed address, changeable only through the timelock and only while idle | Return capital (`return-from-strategy` is callable only by this address) | Sweep, change parameters, pause |
| Guardian | The agent's hot key **[confirm]** | Pause deposits and pause sweeps | Unpause, sweep, return, change anything else |
| Anyone | | Confirm a matured timelocked change, settle nothing on others' behalf | |

**Multisig type: native (SM… address), not a contract multisig.** A native multisig is a
standard principal, so the existing `tx-sender` admin checks work unchanged and there is no
extra contract to audit. A contract multisig would require `contract-caller` based checks
throughout.

Signing tooling (checked 2026-10-08): the project's own `@stacks/transactions` 7.5 builds and
signs native multisig transactions (`numSignatures`, `publicKeys`, non-sequential multisig,
`TransactionSigner`), so admin calls can be scripted with each key signing on its own device.
Asigna offers a native Stacks multisig with cosigning through Leather and Xverse, integrated in
Leather since 2023. Not yet confirmed: hardware-wallet (Ledger) cosigning through Asigna, and
Asigna's current maturity (a small user base). Plan: prove the full admin flow (sweep,
unpause, queue/confirm) with the chosen setup on testnet before any mainnet deploy.

**Recommended key holders [confirm]:** key 1 on a hardware wallet held by the owner, key 2 on
a second hardware wallet stored in a different location, key 3 a recovery key held offline by
a trusted person who is not the reviewer, so the review stays independent. No admin key on
the VPS.

Why sweeps need the admin, not the agent: if the hot key could sweep, a server compromise
could pull up to the cap every epoch. With admin-only sweeps, a compromise can lose at most
what is already deployed, and the guardian role still lets the agent pause instantly.

## 3. State machine

```
            sweep (admin, cap applies)
   IDLE  ─────────────────────────────►  DEPLOYED (epoch n open)
    ▲                                        │
    │   return-from-strategy (strategy only) │
    └──────────── settle epoch n ◄───────────┘
                (atomic, same tx)

   DEPLOYED + burn-block-height > epoch-start + MAX-EPOCH  →  overdue flag set
```

**IDLE** (capital-at-strategy = 0). All capital is in the vault, so NAV is exact.
- Deposits mint shares immediately at the exact price.
- Withdrawal requests lock their payout immediately at the exact price, claimable after
  `WITHDRAWAL-DELAY` burn blocks, paid from ring-fenced STX.
- Admin may sweep only if no timelocked change is pending.
- Admin may queue parameter changes.

**DEPLOYED** (epoch n open).
- Deposits are queued into epoch n. Their STX is held in a separate pending bucket that is
  excluded from assets and can never be swept. A queued depositor can cancel and take the
  STX back any time before settlement.
- Withdrawal requests are queued into epoch n. The shares are escrowed. A queued request can
  be cancelled for the shares back before settlement.
- No sweeps, no parameter queuing (including admin change).
- Overdue: once `MAX-EPOCH` burn blocks pass without a return, `overdue` reads true. It
  changes nothing on-chain beyond what DEPLOYED already blocks, but it is a public signal that
  the strategy has not returned in time, surfaced by the site and the dashboard.

## 4. Per-epoch storage

Clarity cannot loop over a queue, so settlement stores aggregates and a rate, and each user
claims against it later.

```
epochs: epoch-id → {
  start-burn: uint, deployed: uint,
  dep-total: uint,        ;; uSTX queued for deposit (net of cancels)
  wd-shares-total: uint,  ;; shares queued for withdrawal (net of cancels)
  settled: bool,
  dep-shares-minted: uint,;; shares created for all of this epoch's depositors
  wd-stx-paid: uint       ;; uSTX ring-fenced for all of this epoch's withdrawers
}
epoch-deposits:    { epoch, user } → uSTX
epoch-withdrawals: { epoch, user } → shares
```

Claims after settlement:
- deposit: `floor(user-amt × dep-shares-minted / dep-total)` shares, minted on claim.
- withdrawal: `floor(user-shares × wd-stx-paid / wd-shares-total)` uSTX, paid on claim.

Rounding always leaves dust in the vault. Invariant: the sum of all claims never exceeds the
stored totals.

## 5. Order of operations at return

`return-from-strategy` (strategy address only) does all of this in one transaction:

1. Receive the returned STX and book `gain = returned − deployed` into realized P&L.
2. Fee. Compute price per share `PPS = A / S` over settled assets and settled supply only
   (pending deposits and their STX excluded; escrowed withdrawal shares still counted, since
   their owners bore this epoch's result). If `PPS > HWM-PPS`, the fee is
   `fee = (PPS − HWM-PPS) × S × fee-bps`, minted as `fee-shares = fee × S / (A − fee)` so the
   recipient's shares are worth exactly `fee` (L1). Then `HWM-PPS` = post-fee PPS (M1).
3. Price queued withdrawals at the post-fee PPS: ring-fence `wd-stx-paid`, burn the escrowed
   shares.
4. Price queued deposits at the same post-fee, post-withdrawal PPS: record
   `dep-shares-minted`, move `dep-total` from the pending bucket into assets.
5. Mark the epoch settled, return to IDLE, print one settlement event with all totals.

This order means newcomers never pay a fee on gains they did not share, and leavers bear
exactly the epoch they were in (H3 closed in both directions).

## 6. Caps and the limit on losses

The return cannot be forced, so the sweep cap is the real bound on what a strategy failure or
compromise can lose.

| Parameter | Recommended | Changeable |
|---|---|---|
| Max deployed per sweep | **50% of settled assets** net of ring-fenced payouts **[confirm]** | Timelocked, hard ceiling 80% |
| Max vault size | 500 STX for the pilot | Timelocked |
| Performance fee | 10%, hard ceiling 20% | Timelocked |
| Max epoch length | **1,008 burn blocks, about 7 days [confirm]** | Constant |
| Timelock | 1,008 burn blocks, about 7 days | Constant |
| Idle withdrawal delay | 288 burn blocks, about 2 days | Constant |

All delays use `burn-block-height` (L5). The disclosure will state the 50% cap plainly: at
most half the vault can be at the strategy, so a total strategy loss or a compromised
strategy wallet costs depositors at most half.

## 7. Timelock rules

- Every parameter change, including fee recipient, strategy address and admin change, is
  queue/confirm with no cancel; re-queuing restarts the clock.
- Queuing requires IDLE. Sweeping requires no pending change. Together these mean that for the
  whole timelock all capital is home and every holder can exit before a change lands (H2).
  Accepted cost: the strategy sits idle for the full timelock on every change.
- Admin change stays two-step: the proposed admin must accept after maturity.

## 8. Smaller items

- Pricing offset: 1 virtual asset vs 10^3 virtual shares, with shares carrying 9 decimals, so
  the distortion is at most about 1 uSTX instead of 1 STX (L4).
- Zero-value guard: reject any request, deposit or claim worth 0 (L2).
- Events: print on deposit, request, cancel, claim, sweep, return/settle, queue, confirm,
  accept, pause, unpause (L3).
- New token contract with a distinct name and symbol, "DeepStack Vault Shares v2" / `dsSTX2`
  **[confirm]**, linked once to the v2 vault.
- Mint and burn stay gated by `contract-caller` as in v1, which the review found sound.

## 9. Testing and rollout

1. Merge the review suite (PR #13) as the baseline; port its FINDING tests to v2 and flip
   each into a passing regression test.
2. Add epoch invariant tests to the seeded sequences: pending deposits never swept or counted
   in assets; sum of claims ≤ stored totals; ring-fenced payouts always ≤ vault STX;
   settled-state value conservation.
3. Testnet deploy with the site pointed at it, including a claim through the UI (closes M2).
4. Wind down v1: return the 90 STX, request, claim, leave v1 paused and marked deprecated.
5. Mainnet v2 with the owner's own capital: one real gain round trip and one real loss round
   trip, docs updated.
6. Independent re-review before any outside deposit.

## 10. Open items for the owner

1. Multisig key holders (section 2).
2. Sweep cap of 50% of settled assets (section 6).
3. Max epoch length of 1,008 burn blocks (section 6).
4. Whether the agent's hot key should hold the guardian pause role (section 2).
5. Token name and symbol (section 8).
