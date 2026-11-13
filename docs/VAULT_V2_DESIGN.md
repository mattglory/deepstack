# DeepStack Vault v2: design note

Status: draft for review, 2026-10-08. No Clarity code has been written. This note answers the
independent review of v1 (2026-10-07: C1, H1-H3, M1, M2, L1-L5, I1) and the reviewer's design
notes of 2026-10-08. Values marked **[decided]** were confirmed by the owner on 2026-10-10
(section 10).

Revised 2026-10-09 with the reviewer's design-review changes D1-D11. Each change is tagged
**[review D#]** where it lands, so it can be accepted or rejected on its own. D1-D3 are
blocking: without them a failed strategy freezes every holder (H1 survives) and the fee can
be charged on a phantom gain.

Revised 2026-10-11 with the re-review's D12-D13, tagged the same way. D12 is required: without
it, deposits made after a write-off capture the later recovery from the holders who bore the
loss.

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
| Admin | Native Stacks 2-of-3 multisig **[decided]** | Queue/confirm parameter changes, sweep to strategy, unpause, queue admin change | Return capital, bypass the timelock, touch settled payouts |
| Strategy | One fixed address, changeable only through the timelock and only while idle | Return capital (`return-from-strategy` is callable only by this address) | Sweep, change parameters, pause |
| Guardian | The agent's hot key **[decided]**; changed only through the timelock while IDLE **[review D7]** | Pause deposits and pause sweeps | Unpause, sweep, return, change anything else |
| Anyone | | Confirm a matured timelocked change; settle an overdue epoch with `settle-overdue` **[review D1]**; settle nothing else on others' behalf | |

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

**Recommended key holders [decided]:** key 1 on a hardware wallet held by the owner, key 2 on
a second hardware wallet stored in a different location, key 3 a recovery key held offline by
a trusted person who is not the reviewer, so the review stays independent. No admin key on
the VPS. (2026-10-29: the reviewer has joined as a co-founder, so the key 3 holder is to be
re-decided, and independent review now has to come from outside the team.)

**Strategy wallet: dedicated [review D5].** The strategy address holds only vault capital,
never the agent's own trading funds. Its on-chain balance then shows what the strategy
really holds, which makes each self-reported return checkable by anyone. Commingling (as in
v1) makes that impossible.

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

   DEPLOYED + burn-block-height > epoch-start + MAX-EPOCH:
       settle-overdue (anyone) → settle epoch n as a return of 0 → IDLE   [review D1]
       (also pauses deposits, refunds epoch n's queued deposits)        [review D12]
```

**IDLE** (capital-at-strategy = 0). All capital is in the vault, so NAV is exact.
- Deposits mint shares immediately at the exact price.
- Withdrawal requests lock their payout immediately at the exact price, claimable after
  `WITHDRAWAL-DELAY` burn blocks, paid from ring-fenced STX. The shares are burned at request
  time and the payout leaves assets at once **[review D3]**. If they stayed escrowed and
  counted in supply into the next epoch (as in v1), they would share that epoch's result
  while their payout is fixed, which is v1's H3b redistribution.
- Admin may sweep only if no timelocked change is pending.
- Admin may queue parameter changes.

**DEPLOYED** (epoch n open).
- Deposits are queued into epoch n. Their STX is held in a separate pending bucket that is
  excluded from assets and can never be swept. Queued deposits count toward max vault size
  **[review D8]**. A queued depositor can cancel and take the STX back any time before
  settlement; a cancel after settlement is rejected **[review D4]**.
- Withdrawal requests are queued into epoch n. The shares are escrowed. A queued request can
  be cancelled for the shares back before settlement; a cancel after settlement is rejected
  **[review D4]**.
- No sweeps, no parameter queuing (including admin change).
- Overdue **[review D1]**: once `MAX-EPOCH` burn blocks pass without a return, `overdue`
  reads true and anyone may call `settle-overdue`. It settles epoch n exactly as a return of 0
  would (section 5): the deployed amount is booked as a loss, queued withdrawals are handed
  back unpriced **[review D14]**, queued deposits are refunded **[review D12]**, and the vault returns
  to IDLE so every holder can exit. Until someone calls it, `return-from-strategy` still
  settles the epoch normally, even while `overdue` reads true. Without this, a
  total loss (a return of 0 hits the `stx-transfer?` u0 error), a lost strategy key or a
  strategy that keeps the funds leaves the vault DEPLOYED forever: no sweeps, no queuing and
  no IDLE withdrawals, so even the half that never left the vault is frozen (H1).
- Late recovery **[review D1]**: STX the strategy sends after a write-off enters through
  `recover-from-strategy` (strategy only, IDLE only, and only while the write-off's recovery
  window is open **[assessment W-01]**, section 11). It raises assets and so benefits the
  holders at that time; no fee is due until PPS passes `HWM-PPS` again, which follows from
  the fee rule. Disclosed: whoever exits after a write-off misses any later recovery.
- Entry after a write-off **[review D12]**: a write-off leaves IDLE at the written-down PPS,
  where deposits would mint at once, and a later recovery would then be shared with those
  newcomers. So `settle-overdue` also:
  - sets deposits paused. Only the admin can unpause, which it can choose to do before or
    after a recovery. The guardian cannot unpause. Unpausing before a recovery declares the
    loss final: it closes the recovery window **[assessment W-01]**.
  - refunds epoch n's queued deposits 1:1 instead of pricing them: `dep-total` moves from the
    pending bucket to ring-fenced refunds, claimable through the deposit claim as STX, not
    shares. Their money never entered, so it neither bears the loss nor shares the recovery.

  Exact-integer model: a 100 STX vault, 50 swept and written off, a 20 STX deposit queued in
  epoch n, a 50 STX deposit right after the write-off, then a 50 STX recovery. Without D12,
  the original holders end with 70.83 STX: the queued depositor gains 8.33 and the newcomer
  20.83. With D12, the holders end with 100 STX and the queued deposit is refunded 20 STX.
  IDLE withdrawals stay open throughout.
- Exit after a write-off **[review D14]**: pricing epoch n's queued withdrawals at the
  written-down PPS would let any holder who stays call `settle-overdue` on a strategy that is
  merely late and keep the leavers' share of the recovery. In a Clarinet test with 200 STX,
  100 swept and returned in full after `MAX-EPOCH`, the leaver got 50 STX and the stayer's
  position rose to 150. So a written-off epoch's escrowed withdrawal shares go back to their
  owners on claim, unpriced. They are holders again: they can exit IDLE at once at the same
  written-down price, or wait for a recovery.

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
  wd-stx-paid: uint,      ;; uSTX ring-fenced for all of this epoch's withdrawers
  written-off: bool       ;; settled by settle-overdue: deposits refunded [review D12]
}
epoch-deposits:    { epoch, user } → uSTX
epoch-withdrawals: { epoch, user } → shares
```

Claims after settlement:
- deposit: `floor(user-amt × dep-shares-minted / dep-total)` shares, transferred on claim
  from the vault's own escrow. All `dep-shares-minted` are minted to the vault at settlement,
  not on claim **[review D2]**. In a written-off epoch the deposit claim instead pays back
  `user-amt` in uSTX from the ring-fenced refunds **[review D12]**.
- withdrawal: `floor(user-shares × wd-stx-paid / wd-shares-total)` uSTX, paid on claim.
- Each claim deletes the user's `{epoch, user}` record, so it cannot be repeated. A second
  deposit or request in the same epoch adds to the record; a cancel subtracts from both the
  record and the epoch total. A claim that rounds to 0 still deletes the record instead of
  reverting forever **[review D4]**.

Accounting definitions, used by every formula in section 5 **[review D2]**:
- `S` = the token's real total supply, including shares escrowed for queued withdrawals (they
  bear the current epoch) and settled deposit shares held in escrow until claimed.
- `A` = capital at strategy + vault STX − pending-deposit bucket − all ring-fenced payouts
  (IDLE requests, settled epoch withdrawals and written-off deposit refunds **[review D12]**).

Why minting on claim fails: unclaimed deposit shares would be missing from `S` while their
STX is already in `A`. Modelled with exact integers, a zero-profit epoch with a 100 STX
queued deposit into a 100 STX vault leaves PPS reading 0.002 instead of 0.001 for as long as
the deposit is unclaimed, and the next settlement charges a fee on that phantom +100% gain.

Rounding always leaves dust in the vault. Invariant: the sum of all claims never exceeds the
stored totals (modelled: 37 floored deposit claims left 16 share units of dust). Value
invariant: `A` + ring-fenced payouts + pending-deposit bucket = vault STX + capital at
strategy, after every call.

## 5. Order of operations at return

`return-from-strategy` (strategy address only) does all of this in one transaction.
`settle-overdue` runs the same steps with `returned = 0` **[review D1]**:

1. Receive the returned STX and book `gain = returned − deployed` into realized P&L. A return
   of 0 is allowed and skips the transfer **[review D1]**.
2. Fee. Compute price per share `PPS = A / S` over settled assets and settled supply only
   (pending deposits and their STX excluded; escrowed withdrawal shares still counted, since
   their owners bore this epoch's result). If `PPS > HWM-PPS`, the fee is
   `fee = (PPS − HWM-PPS) × S × fee-bps`, minted as `fee-shares = fee × S / (A − fee)` so the
   recipient's shares are worth exactly `fee` (L1). Then `HWM-PPS` = post-fee PPS (M1).
3. Price queued withdrawals at the post-fee PPS: ring-fence `wd-stx-paid`, burn the escrowed
   shares.
4. Price queued deposits at the same post-fee, post-withdrawal PPS: record
   `dep-shares-minted`, move `dep-total` from the pending bucket into assets.
   `settle-overdue` instead refunds them: it moves `dep-total` from the pending bucket to
   ring-fenced refunds, sets `written-off`, and pauses deposits **[review D12]**.
5. Mark the epoch settled, return to IDLE, print one settlement event with all totals.

This order means newcomers never pay a fee on gains they did not share, and leavers bear
exactly the epoch they were in (H3 closed in both directions).

Precision and rounding **[review D6]**: PPS and `HWM-PPS` use a stated fixed-point scale of 1e18 in uint128 **[decided]**, since PPS is about 0.001 uSTX per share unit with the new offset.
Round the fee down and `HWM-PPS` up, so rounding residue is never charged twice. Apply the
same virtual offsets in every formula (PPS, fee, claims). Checked with an exact-integer
model: on a +100% epoch with a 10% fee, `fee-shares = fee × S / (A − fee)` gives the
recipient 9,999,999.998795 uSTX of a nominal 10 STX (L1 fixed).

## 6. Caps and the limit on losses

The return cannot be forced, so the sweep cap is the real bound on what a strategy failure or
compromise can lose.

| Parameter | Recommended | Changeable |
|---|---|---|
| Max deployed per sweep | **50% of settled assets** net of ring-fenced payouts **[decided]** | Timelocked, hard ceiling 80% |
| Max vault size | 500 STX for the pilot | Timelocked |
| Performance fee | 10%, hard ceiling 20% | Timelocked |
| Max epoch length | **432 burn blocks, about 3 days [decided]** | Constant |
| Timelock | 1,008 burn blocks, about 7 days | Constant |
| Idle withdrawal delay | 288 burn blocks, about 2 days | Constant |

All delays use `burn-block-height` (L5). The disclosure will state the 50% cap plainly: at
most half the vault can be at the strategy, so a total strategy loss or a compromised
strategy wallet costs depositors at most half.

What the cap does not bound **[review D5]**: a strategy that returns slightly less every
epoch, booked as losses, can skim over many epochs. Mitigations: the admin multisig reviews
each settlement (and the dedicated strategy wallet's balance) before sweeping again, and
sweeps are blocked automatically once PPS falls more than **10% below `HWM-PPS` [decided]**,
resumable only by the admin through the timelock. Whatever remains is
disclosed: the returned amount is self-reported by the strategy **[review D11]**.

How the block resumes **[review D13]**: after a drawdown, PPS only gets back to `HWM-PPS`
through gains, and gains need sweeps. So a resume that only clears a flag would trip again at
the very next sweep. The block therefore measures against its own reference, not `HWM-PPS`
itself:
- `sweep-ref-pps` (same 1e18 scale) starts at the initial PPS. Each settlement raises it to
  the post-fee PPS when that is higher, so it tracks `HWM-PPS` until the first resume.
- A sweep requires `PPS × 10 ≥ sweep-ref-pps × 9`, in integers with no division.
- Resume is a timelocked change (queued while IDLE like any other). At confirm it resets
  `sweep-ref-pps` to the PPS at that moment.
- `HWM-PPS` is never touched by the block or the resume, so the fee still waits for a full
  recovery.

A further loss of more than 10% from the reset point blocks sweeps again. Modelled with
integers: a -30% epoch blocks the sweep; clearing a flag alone still blocks it; a reset
allows it; a further -8% is still allowed; a cumulative loss past 10% from the reset blocks
again.

Worst-case exit time **[review D9]**, to state in the disclosure: 288 burn blocks from IDLE;
up to `MAX-EPOCH` plus settlement while DEPLOYED (with D1 this is a hard bound). DLMM
positions unwind in minutes, so `MAX-EPOCH` is set to 432 burn blocks **[decided]**: about 3
days, short enough to bound queued exits, long enough that each new sweep's two multisig
signatures are not needed every day.

## 7. Timelock rules

- Every parameter change, including fee recipient, strategy address and admin change, is
  queue/confirm with no cancel; re-queuing restarts the clock.
- Queuing requires IDLE. Sweeping requires no pending change. Together these mean that for the
  whole timelock all capital is home and every holder can exit before a change lands (H2).
  Accepted cost: the strategy sits idle for the full timelock on every change.
- Admin change stays two-step: the proposed admin must accept after maturity.
- Strategy change is two-step too: the proposed strategy must accept after maturity
  **[assessment W-02]**.

## 8. Smaller items

- Pricing offset: 1 virtual asset vs 10^3 virtual shares, with shares carrying 9 decimals, so
  the distortion is at most about 1 uSTX instead of 1 STX (L4).
- Zero-value guard: reject any request, deposit or claim worth 0 (L2).
- Events: print on deposit, request, cancel, claim, sweep, return/settle, queue, confirm,
  accept, pause, unpause (L3).
- New token contract with a distinct name and symbol, "DeepStack Vault Shares v2" / `dsSTX2`
  **[decided]**, linked once to the v2 vault.
- Mint and burn stay gated by `contract-caller` as in v1, which the review found sound.
- Defense in depth **[review D10]**: if the target epoch supports Clarity 4, consider
  `as-contract?` with explicit STX allowances, so a sweep can never move more than the cap
  even if the arithmetic is wrong. Verify availability on mainnet before relying on it.

## 9. Testing and rollout

1. Merge the review suite (PR #13) as the baseline; port its FINDING tests to v2 and flip
   each into a passing regression test.
2. Add epoch invariant tests to the seeded sequences: pending deposits never swept or counted
   in assets; sum of claims ≤ stored totals; ring-fenced payouts always ≤ vault STX;
   settled-state value conservation.
   **[review]** Also: a total-loss settlement; `settle-overdue` after `MAX-EPOCH`, then a late
   recovery; a lost strategy key (D1); PPS unchanged across a zero-profit epoch with a queued
   deposit (D2); an IDLE request followed by a loss epoch, where the leaver's payout is fixed
   and the remaining holders' PPS is unaffected (D3); double claim, cancel after settlement
   and a zero-value claim (D4).
   **[review D12]** A write-off, then a deposit attempt (rejected while paused), then a
   recovery that raises PPS for the existing holders only; queued deposits refunded 1:1 on a
   write-off, claimed as STX; `return-from-strategy` still settles normally while `overdue`
   reads true. **[review D14]** A write-off returns queued withdrawal shares unpriced, and a
   later recovery makes leaver and stayer whole; nothing can be queued before `initialize`.
   **[review D13]** A loss of more than 10% blocks the sweep; a resume is queued and
   confirmed; the sweep then works and `HWM-PPS` is unchanged; a further loss of more than 10%
   from the reset point blocks again. Also a max-value test of every 1e18-scaled product.
3. Testnet deploy with the site pointed at it, including a claim through the UI (closes M2).
4. Wind down v1: return the 90 STX, request, claim, leave v1 paused and marked deprecated.
   Done 2026-10-10 (section 10).
5. Mainnet v2 with the owner's own capital: one real gain round trip and one real loss round
   trip, docs updated.
6. Re-review by someone outside the team (the original reviewer is now a co-founder) before any
   outside deposit.

## 10. Owner decisions (2026-10-10)

All of the reviewer's changes D1-D11 are accepted as written. Decisions:

1. Admin: native Stacks 2-of-3 multisig. Key 1 on the owner's hardware wallet, key 2 on a
   second hardware wallet stored elsewhere, key 3 a recovery key held offline by a trusted
   person who is not the reviewer. Holder identities are kept out of public docs.
2. Sweep cap: 50% of settled assets, timelocked, hard ceiling 80%.
3. `MAX-EPOCH`: 432 burn blocks, about 3 days, with `settle-overdue` (D1).
4. Guardian: the agent's hot key, pause-only, changed only through the timelock while IDLE (D7).
5. Token: "DeepStack Vault Shares v2" / `dsSTX2`.
6. Drawdown sweep block (D5): sweeps stop once PPS is more than 10% below `HWM-PPS`; only the
   admin can resume them, through the timelock.
7. Fixed-point scale (D6): 1e18 in uint128.

v1 status: fully wound down on 2026-10-10. The 90 STX was returned from the strategy,
withdrawn as request #1 and claimed (tx 9a1b1c05...). v1 stays paused and deprecated.

Next: the reviewer re-reviews this revised note; then Clarity code, test-first; then testnet.

Re-review (2026-10-11) **[review]**: the decisions above are fine, and the note is approved
once D12 is accepted:
- D12 (required): `settle-overdue` pauses deposits and refunds epoch n's queued deposits
  (section 3). The 3-day `MAX-EPOCH` makes a late return that later recovers the usual cause
  of a write-off, so without D12 newcomers routinely capture recoveries.
- D13 (clarifies decision 6): resuming after the drawdown block resets `sweep-ref-pps`
  (section 6).

Decision 7 checked: with every STX in existence in the vault, the largest 1e18-scaled product
(the fee step) is about 6e36, below 2^128 ≈ 3.4e38, provided no two scaled terms are
multiplied before dividing. v1 wind-down checked on chain: the claim of request #1 returned
`(ok u90000000)`. It was sent without post-conditions, so it doesn't prove the frontend claim
fix. M2 still closes at step 3.

## 11. Assessment fixes (2026-11-03)

The 2026-11-03 security assessment (annex A2, section 4) found three contract issues in the
code approved above. Each fix is tagged so it can be reviewed on its own. Regression tests:
`clarinet/tests/vault-v2-assessment.test.ts`, the initialize cases in
`vault-v2-preinit.test.ts`, and the value-transfer fuzz in `vault-v2.test.ts`. Of the 23
new tests, 15 fail on the pre-fix contract (690c5b0). The other 8 pass there and pin
properties that already held, so the fix cannot break them: four W-01 cases (pro-rata IDLE
holder, repeated recoveries, exits around a recovery, queued pricing), the positive
initialize case, and three extended fuzz seeds.

### Accounting invariant [assessment W-01]

No holder's value may change because of another actor's deposit, withdrawal, claim, cancel or
donation, beyond integer rounding (a few uSTX, always in the vault's favour). It may change only
through strategy results (settlement, write-off, recovery) and the fee. A recovery pays back a
booked loss, so none of it may reach shares acquired after that loss was booked.

The pre-fix contract broke the second half. `recover-from-strategy` worked at any IDLE time,
and IDLE deposits price immediately. So anyone who saw a recovery coming (for example in the
mempool) could deposit just before it and exit just after. Probe P1: alice holds 100 STX, the
strategy returns 25 of 50, mallory deposits 150, the strategy recovers 25, and mallory exits
with +16.67 STX while alice ends at 83.33 instead of 100. The D12 pause did not cover it: it
is set only by `settle-overdue`, and `unpause-deposits` could run before the recovery.

Options considered:

1. **Require `deposits-paused` inside `recover-from-strategy`.** Not enough. The pause is a
   separate transaction after the loss, so the attacker deposits before the pause instead
   (front-running `pause-deposits`). A pause, unpause and re-pause cycle also passes the check
   with newcomers inside.
2. **Allow recovery only after a write-off, and block `unpause-deposits` until a recovery is
   booked.** Closes the hole, but a strategy that never recovers would leave deposits paused
   for good.
3. **Chosen: a recovery window.** `settle-overdue` already pauses deposits in the same
   transaction that books the write-off (D12). It now also sets `recovery-open`.
   `unpause-deposits` clears it, and `recover-from-strategy` requires it (`err u327`
   otherwise). While the window is open, no share can have entered since the loss: deposits
   are refused, and queued deposits of the written-off epoch were refunded 1:1. So the
   holders who gain are exactly the ones who bore the loss, less any who chose to exit (as
   disclosed under D1). The admin keeps the choice D12 gave it. Wait for the recovery, or
   unpause and so declare the loss final. The window survives later normal settlements,
   because deposits stay paused; it reopens only at the next write-off.

What is no longer possible: a recovery after a normal partial return (P1's path). If the
strategy cannot unwind in time, it has two clean routes. It can return what it has as part
of a full later return before `MAX-EPOCH`. Or it can let the epoch go overdue, which writes
it off and opens the window. STX it returns in a later epoch is booked as that epoch's
result, priced with that epoch's queue. Residual risk, unchanged and already disclosed
(D11): a strategy that holds STX off the books can tell outsiders when to deposit. The
contract cannot see off-book balances.

Tests (`vault-v2-assessment.test.ts`, "W-01"):

- P1 is refused.
- A deposit queued before the write-off is refunded and gets none of the recovery.
- An IDLE holder from before the sweep shares the loss and the recovery pro rata.
- Unpausing closes the window, and re-pausing does not reopen it.
- Several partial recoveries are allowed.
- A withdrawal request does not move another holder's value; a leaver before the recovery
  forfeits it.
- Deposit-then-recover and recover-then-deposit in the same block are both safe, and after an
  unpause the recovery is refused.
- Several queued deposits, cancels and withdrawals around a normal settlement are priced
  after the result.

Fuzz (`vault-v2.test.ts`, "seeded invariants"): every actor's value is tracked as shares x
PPS plus queued and claimable amounts. After each user call, every other actor's value must
be unchanged within 3 uSTX. After each recovery, no gain may reach shares acquired since the
last loss. The five original seeds keep their exact sequence and gain these checks. Five
extended seeds add recoveries, donations straight to the vault, and write-offs without an
automatic unpause.

On the pre-fix contract, extended seeds 7 and 65537 fail with "recovery paid 759649 uSTX
(and 6010940 uSTX) to shares acquired after the loss". The solvency-only checks had passed
every seed.

### Strategy acceptance [assessment W-02]

`confirm-strategy` (anyone, after maturity) is replaced by `accept-strategy-change`, which
only the proposed strategy can call after maturity (`err u328` otherwise). This mirrors
`accept-admin-change`. The timelock, the IDLE requirement and "re-queuing restarts the clock"
are unchanged.

A mistyped principal can never accept, so it never becomes the sweep destination. The
unaccepted change keeps `no-change-pending` false, which blocks sweeps until the admin
re-queues a correct address. Exits are unaffected.

Tooling follows: the multisig allow-list drops `confirm-strategy`, and the new strategy
accepts with `vault-v2-cli accept-strategy` using its own key. Guardian and fee-recipient
changes stay one-step. Neither receives sweeps, and the fee recipient only receives shares.

Test: "P3 fixed". A typo principal is queued; nobody else can complete the change, sweeps are
blocked, the typo address receives 0, and a re-queued correct address accepts and receives the
next sweep.

### Role separation at initialize [assessment W-03]

`initialize` now refuses (`err u326`):

- admin = deployer, or strategy = deployer. The deployer key may be a hot key, and N3 is a
  deployer front-running its own initialize.
- admin = strategy, admin = guardian, or strategy = guardian. Section 2 makes these three
  different principals: the admin is the multisig, the guardian is the agent's hot key (so
  admin = guardian would put the hot key on sweeps, C1), and the strategy is a dedicated
  wallet (D5).

Guardian and fee recipient may be the deployer; the testnet deployment uses that.

The same check runs when a strategy, guardian or admin change is queued, and again when it
lands. This covers two changes queued together that would merge roles only once both land.

These are cheap on-chain checks. They do not replace the deploy procedure that closes the
front-running window itself: deploy and initialize back to back from a fresh key, then
verify (the deploy tooling, roadmap C10).

Tests: five negative initialize cases and one positive case in `vault-v2-preinit.test.ts`;
queue-time and land-time cases in `vault-v2-assessment.test.ts`.

### Overflow after a price collapse [assessment N5]

The test drives twelve 80% losses into a 90M STX vault: PPS falls about 2.4e8 times, so
supply exceeds assets by more than 1e11. On the pre-fix contract, a new 90M STX deposit then
minted about 2.2e25 shares. The next `return-from-strategy` aborted with ArithmeticOverflow
on `wd-shares x assets`. `settle-overdue` still worked, because D14 skips pricing on a
write-off, so it was not a full deadlock. But every epoch could then only end as a
write-off. IDLE deposits overflowed, and a large exit had to be split into chunks.

Guard: `deposit` refuses (`err u329`) once PPS is below `MIN-PPS` = launch price / 10,000.
One epoch can cut PPS by at most 5x (80% sweep ceiling). So shares are only ever minted at
or above MIN-PPS / 5, which bounds supply at about 9e22 even with every STX in existence
deposited. That keeps every product below 2^128. Exits are unaffected. Disclosed: after a
99.99% collapse the vault accepts no new deposits.

