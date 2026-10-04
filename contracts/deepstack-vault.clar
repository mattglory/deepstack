;; DeepStack AUM Vault -- Phase 1 (capped pilot)
;;
;; STATUS: NOT YET DEPLOYED. Proven on Clarinet's simnet first; an actual mainnet deploy, even
;;   seeded only with DeepStack's own capital, is a separate later decision. See
;;   docs/VAULT_DISCLOSURE.md for the plain-language version of everything below, and
;;   reports/DeepStack AUM vault architecture.md for the design research this is built from.
;;
;; A single-strategy, non-custodial vault: depositors receive deepstack-vault-token (dsSTX)
;; shares priced against the vault's own internally-tracked assets; the operator periodically
;; sweeps free capital out to run the existing, already-proven off-chain DLMM strategy
;; (src/m1/dlmm-recenter-exec.ts) and returns it, with a performance fee minted on realized
;; gains above a high-water mark. No management fee, no promised return anywhere.
;;
;; Modeled on StackingDAO's (Arkadiko) audited liquid-staking vault
;; (github.com/StackingDAO/contracts, CoinFabrik audit Nov 2023) -- the best Clarity-native
;; vault precedent that exists -- with two deliberate departures, both load-bearing:
;;
;; 1. SHARE PRICING NEVER SPECIAL-CASES ZERO SUPPLY. StackingDAO hardcodes a flat 1:1 first
;;    mint when supply is zero, with no floor and no offset -- a real donation/inflation-attack
;;    gap their own audit never flagged. This contract uses an always-on virtual-shares/
;;    virtual-assets offset (the OpenZeppelin/Solmate pattern) plus a hard minimum first
;;    deposit, so there is no special branch and no viable tiny-seed-then-donate setup. Total
;;    assets are read ONLY from this contract's own ledger vars, never from stx-get-balance --
;;    a bare STX transfer straight to this contract's address is simply invisible to the
;;    pricing formula.
;;
;; 2. WITHDRAWALS CANNOT BE PAUSED, BECAUSE NO CODE PATH TO PAUSE THEM EXISTS. StackingDAO's
;;    original version let admin block/throttle withdrawals via a shutdown flag and a settable
;;    threshold; their own audit found this Critical (CR-01, "Blocked Withdrawals and Stolen
;;    Rewards") and the fix was to remove the mechanism entirely, not to constrain it. This
;;    contract applies that lesson from the start: pause-deposits/pause-strategy exist and are
;;    instant, but claim-withdrawal reads no pause flag of any kind, because none exists that
;;    could apply to it. A withdrawal request can only be ACCEPTED if the vault already holds
;;    the free STX to cover it right now, and accepted requests are immediately ring-fenced
;;    (sweep-to-strategy cannot touch reserved STX) -- so once accepted, a request cannot later
;;    become unfundable.
;;
;; Admin parameter changes (TVL cap, performance fee, fee recipient, admin succession) route
;; through a timelock with NO cancel path, for any of them, ever -- a timelock the same
;; operator can skip "provides a false sense of security." A mistaken queue is corrected by
;; queuing the old value back, which itself waits out the same delay.
;;
;; BEFORE DEPLOYING:
;;   1. Deploy deepstack-vault-token.clar FIRST (this contract hardcodes a literal reference
;;      to it, so it must already exist on-chain).
;;   2. Deploy this contract.
;;   3. Call deepstack-vault-token's set-vault-contract with THIS contract's address (the
;;      one-time link -- see that file's header).
;;   4. Verify WITHDRAWAL-DELAY-BLOCKS / TIMELOCK-DELAY-BLOCKS below against mainnet's actual
;;      block cadence at deploy time (computed here from observed Nakamoto-era blocks on
;;      2026-10-04: ~10-12 seconds/block; using a conservative 10s/block assumption so the
;;      real delay is never SHORTER than intended if blocks speed up further) -- re-verify
;;      before relying on this number for a real deploy.

;; =============================================
;; Constants -- verify before deploy
;; =============================================

(define-constant VIRTUAL-SHARES u1000000) ;; always-on offset, closes the donation-attack gap
(define-constant VIRTUAL-ASSETS u1000000) ;; (see header, point 1) -- never zero, no special case

(define-constant MIN-FIRST-DEPOSIT u1000000) ;; 1 STX floor while supply is still zero

(define-constant MAX-PERFORMANCE-FEE-BPS u2000) ;; 20% hard ceiling -- even a fully-matured,
                                                  ;; properly-queued fee change can never exceed this

;; ~3 days at a conservative 10s/block (see header) -- fixed constants in Phase 1, not even
;; timelock-adjustable: one admin, one strategy, no proven need yet to ever change these.
(define-constant WITHDRAWAL-DELAY-BLOCKS u26000)
(define-constant TIMELOCK-DELAY-BLOCKS u26000)

(define-constant ERR-NOT-ADMIN                 (err u100))
(define-constant ERR-DEPOSITS-PAUSED           (err u101))
(define-constant ERR-STRATEGY-PAUSED           (err u102))
(define-constant ERR-ZERO-AMOUNT               (err u103))
(define-constant ERR-BELOW-MIN-FIRST-DEPOSIT   (err u104))
(define-constant ERR-ZERO-SHARES               (err u105))
(define-constant ERR-OVER-CAP                  (err u106))
(define-constant ERR-INSUFFICIENT-LIQUIDITY    (err u107))
(define-constant ERR-WITHDRAWAL-NOT-FOUND      (err u108))
(define-constant ERR-NOT-WITHDRAWAL-OWNER      (err u109))
(define-constant ERR-ALREADY-CLAIMED           (err u110))
(define-constant ERR-NOT-YET-CLAIMABLE         (err u111))
(define-constant ERR-STRATEGY-ALREADY-DEPLOYED (err u112))
(define-constant ERR-NO-STRATEGY-CAPITAL       (err u113))
(define-constant ERR-NOTHING-QUEUED            (err u114))
(define-constant ERR-NOT-YET-EXECUTABLE        (err u115))
(define-constant ERR-NOT-PENDING-ADMIN         (err u116))
(define-constant ERR-FEE-TOO-HIGH              (err u117))

;; =============================================
;; Core ledger -- these, and only these, define "total assets". Never stx-get-balance.
;; =============================================

(define-data-var total-stx-balance uint u0)   ;; STX actually held by this contract right now
(define-data-var capital-at-strategy uint u0) ;; STX currently swept out to the strategy

(define-data-var cumulative-realized-pnl int 0)
(define-data-var realized-pnl-high-water-mark int 0)

;; =============================================
;; Admin-settable parameters (timelocked -- see Timelock section)
;; =============================================

(define-data-var admin principal tx-sender)
(define-data-var max-tvl uint u500000000)        ;; 500 STX initial pilot cap
(define-data-var performance-fee-bps uint u1000) ;; 10% initial
(define-data-var fee-recipient principal tx-sender)

(define-data-var deposits-paused bool false)
(define-data-var strategy-paused bool false)

;; =============================================
;; Read-only: assets, share pricing (pure given current ledger state)
;; =============================================

(define-read-only (get-total-assets)
  (+ (var-get total-stx-balance) (var-get capital-at-strategy))
)

(define-read-only (get-free-balance)
  (- (var-get total-stx-balance) (var-get total-pending-withdrawals))
)

;; unwrap-panic is safe here: get-total-supply is a read-only on OUR OWN token contract
;; (deepstack-vault-token.clar) that always returns (ok ...) with no possible error path --
;; not an external/unpredictable call, so there's no real failure mode to propagate gracefully.
(define-read-only (shares-for-deposit (amount uint))
  (let (
    (supply (unwrap-panic (contract-call? .deepstack-vault-token get-total-supply)))
    (assets (get-total-assets))
  )
    (/ (* amount (+ supply VIRTUAL-SHARES)) (+ assets VIRTUAL-ASSETS))
  )
)

(define-read-only (assets-for-shares (shares uint))
  (let (
    (supply (unwrap-panic (contract-call? .deepstack-vault-token get-total-supply)))
    (assets (get-total-assets))
  )
    (/ (* shares (+ assets VIRTUAL-ASSETS)) (+ supply VIRTUAL-SHARES))
  )
)

;; Pure: fee owed for a round-trip's gain, given the new cumulative total and the PRIOR
;; high-water mark. Only the portion above the prior peak is fee-able -- a loss, or a recovery
;; that doesn't yet clear the old peak, owes zero and does not lower the bar for next time.
(define-read-only (fee-stx-for-round-trip (new-cumulative-pnl int) (prior-hwm int))
  (if (> new-cumulative-pnl prior-hwm)
    (/ (* (to-uint (- new-cumulative-pnl prior-hwm)) (var-get performance-fee-bps)) u10000)
    u0
  )
)

;; =============================================
;; Deposit
;; =============================================

(define-public (deposit (amount uint))
  (let (
    (depositor tx-sender)
    (supply (unwrap-panic (contract-call? .deepstack-vault-token get-total-supply))) ;; safe: see shares-for-deposit's comment above
    (shares (shares-for-deposit amount))
  )
    (asserts! (not (var-get deposits-paused)) ERR-DEPOSITS-PAUSED)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (asserts! (or (> supply u0) (>= amount MIN-FIRST-DEPOSIT)) ERR-BELOW-MIN-FIRST-DEPOSIT)
    (asserts! (> shares u0) ERR-ZERO-SHARES)
    (try! (stx-transfer? amount depositor (as-contract tx-sender)))
    (var-set total-stx-balance (+ (var-get total-stx-balance) amount))
    (asserts! (<= (get-total-assets) (var-get max-tvl)) ERR-OVER-CAP)
    (try! (as-contract (contract-call? .deepstack-vault-token mint-for-vault shares depositor)))
    (ok shares)
  )
)

;; =============================================
;; Delayed withdrawal -- a map record, not an NFT (see reports/DeepStack AUM vault
;; architecture.md: Phase 1 has no external unlock calendar and, by design, very few
;; depositors at first, so a non-transferable record is simpler to audit than a full
;; claim-ticket NFT with transfer/marketplace logic. See header, point 2, for the
;; CR-01 "cannot be paused" property this section implements.
;; =============================================

(define-map withdrawal-requests uint
  {
    owner: principal,
    shares: uint,
    locked-stx-amount: uint,
    claimable-at: uint,
    claimed: bool,
  }
)
(define-data-var next-withdrawal-id uint u0)
(define-data-var total-pending-withdrawals uint u0)

;; Can only succeed if the vault already holds the free STX to cover it RIGHT NOW. An accepted
;; request is immediately ring-fenced (added to total-pending-withdrawals); sweep-to-strategy
;; is bound by the same free-balance figure, so the admin can never sweep away STX already
;; owed to a pending request. Honest limitation, disclosed not hidden: if capital happens to
;; be fully deployed at the strategy when someone asks, this call is simply REJECTED (not
;; paused, not queued) -- a liquidity-timing fact, not an admin decision either way.
(define-public (request-withdrawal (shares uint))
  (let (
    (owner tx-sender)
    (locked-amount (assets-for-shares shares))
    (id (var-get next-withdrawal-id))
  )
    (asserts! (> shares u0) ERR-ZERO-AMOUNT)
    (asserts! (<= locked-amount (get-free-balance)) ERR-INSUFFICIENT-LIQUIDITY)
    (try! (contract-call? .deepstack-vault-token transfer shares owner (as-contract tx-sender) none))
    (var-set total-pending-withdrawals (+ (var-get total-pending-withdrawals) locked-amount))
    (map-set withdrawal-requests id
      {
        owner: owner,
        shares: shares,
        locked-stx-amount: locked-amount,
        claimable-at: (+ stacks-block-height WITHDRAWAL-DELAY-BLOCKS),
        claimed: false,
      }
    )
    (var-set next-withdrawal-id (+ id u1))
    (ok id)
  )
)

;; No pause check of any kind -- see header, point 2. Payout is the amount LOCKED AT REQUEST
;; TIME (via assets-for-shares back when request-withdrawal ran), never recomputed here, so a
;; fee mint or market move between request and claim cannot change what's owed.
(define-public (claim-withdrawal (id uint))
  (let (
    (claimant tx-sender)
    (request (unwrap! (map-get? withdrawal-requests id) ERR-WITHDRAWAL-NOT-FOUND))
  )
    (asserts! (is-eq (get owner request) claimant) ERR-NOT-WITHDRAWAL-OWNER)
    (asserts! (not (get claimed request)) ERR-ALREADY-CLAIMED)
    (asserts! (>= stacks-block-height (get claimable-at request)) ERR-NOT-YET-CLAIMABLE)
    (var-set total-stx-balance (- (var-get total-stx-balance) (get locked-stx-amount request)))
    (var-set total-pending-withdrawals (- (var-get total-pending-withdrawals) (get locked-stx-amount request)))
    (try! (as-contract (stx-transfer? (get locked-stx-amount request) tx-sender claimant)))
    (try! (as-contract (contract-call? .deepstack-vault-token burn-for-vault (get shares request) tx-sender)))
    (map-set withdrawal-requests id (merge request { claimed: true }))
    (ok (get locked-stx-amount request))
  )
)

;; =============================================
;; Strategy linkage -- moves STX between vault custody and the operator's existing wallet via
;; plain stx-transfer?; recenterOnce() (src/m1/dlmm-recenter-exec.ts) is never modified, the
;; off-chain agent just sees a bigger free balance to work with after a sweep. One tranche at a
;; time (Phase 1 scope: no need to track multiple concurrent cost bases for a single strategy).
;; =============================================

(define-public (sweep-to-strategy (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (not (var-get strategy-paused)) ERR-STRATEGY-PAUSED)
    (asserts! (is-eq (var-get capital-at-strategy) u0) ERR-STRATEGY-ALREADY-DEPLOYED)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (asserts! (<= amount (get-free-balance)) ERR-INSUFFICIENT-LIQUIDITY)
    (var-set total-stx-balance (- (var-get total-stx-balance) amount))
    (var-set capital-at-strategy amount)
    (as-contract (stx-transfer? amount tx-sender (var-get admin)))
  )
)

;; Deliberately NOT gated on strategy-paused -- bringing capital BACK under vault custody must
;; never be pausable, same CR-01 reasoning as withdrawals (header, point 2).
(define-public (return-from-strategy (returned-amount uint))
  (let (
    (deployed (var-get capital-at-strategy))
    (prior-hwm (var-get realized-pnl-high-water-mark))
    (gain (- (to-int returned-amount) (to-int deployed)))
  )
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (> deployed u0) ERR-NO-STRATEGY-CAPITAL)
    (try! (stx-transfer? returned-amount tx-sender (as-contract tx-sender)))
    (var-set total-stx-balance (+ (var-get total-stx-balance) returned-amount))
    (var-set capital-at-strategy u0)
    (let ((new-total (+ (var-get cumulative-realized-pnl) gain)))
      (var-set cumulative-realized-pnl new-total)
      (if (> new-total prior-hwm) (var-set realized-pnl-high-water-mark new-total) true)
      (let ((fee-stx (fee-stx-for-round-trip new-total prior-hwm)))
        (if (> fee-stx u0)
          (let ((fee-shares (shares-for-deposit fee-stx)))
            (if (> fee-shares u0)
              (try! (as-contract (contract-call? .deepstack-vault-token mint-for-vault fee-shares (var-get fee-recipient))))
              true
            )
          )
          true
        )
      )
    )
    (ok returned-amount)
  )
)

;; =============================================
;; Pause -- scoped to new deposits and new strategy allocation ONLY. Instant, not timelocked:
;; a defensive brake that only ever turns things off should never be slowed by the same
;; mechanism designed to stop quiet value-extraction. See header, point 2 for what this
;; deliberately cannot reach.
;; =============================================

(define-public (pause-deposits)
  (begin (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN) (var-set deposits-paused true) (ok true))
)
(define-public (unpause-deposits)
  (begin (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN) (var-set deposits-paused false) (ok true))
)
(define-public (pause-strategy)
  (begin (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN) (var-set strategy-paused true) (ok true))
)
(define-public (unpause-strategy)
  (begin (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN) (var-set strategy-paused false) (ok true))
)

;; =============================================
;; Timelock -- queue/confirm, NO cancel path anywhere for any of these, ever. A mistaken queue
;; is corrected by queuing the old value back, which itself waits out the same delay. confirm-*
;; is callable by ANYONE once matured, removing the operator's own discretion over timing.
;; =============================================

(define-data-var pending-max-tvl (optional { value: uint, executable-at: uint }) none)
(define-data-var pending-fee-bps (optional { value: uint, executable-at: uint }) none)
(define-data-var pending-fee-recipient (optional { value: principal, executable-at: uint }) none)
(define-data-var pending-admin (optional { value: principal, executable-at: uint }) none)

(define-public (queue-max-tvl (new-value uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (var-set pending-max-tvl (some { value: new-value, executable-at: (+ stacks-block-height TIMELOCK-DELAY-BLOCKS) }))
    (ok true)
  )
)
(define-public (confirm-max-tvl)
  (let ((pending (unwrap! (var-get pending-max-tvl) ERR-NOTHING-QUEUED)))
    (asserts! (>= stacks-block-height (get executable-at pending)) ERR-NOT-YET-EXECUTABLE)
    (var-set max-tvl (get value pending))
    (var-set pending-max-tvl none)
    (ok true)
  )
)

(define-public (queue-fee-bps (new-value uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (<= new-value MAX-PERFORMANCE-FEE-BPS) ERR-FEE-TOO-HIGH)
    (var-set pending-fee-bps (some { value: new-value, executable-at: (+ stacks-block-height TIMELOCK-DELAY-BLOCKS) }))
    (ok true)
  )
)
(define-public (confirm-fee-bps)
  (let ((pending (unwrap! (var-get pending-fee-bps) ERR-NOTHING-QUEUED)))
    (asserts! (>= stacks-block-height (get executable-at pending)) ERR-NOT-YET-EXECUTABLE)
    (var-set performance-fee-bps (get value pending))
    (var-set pending-fee-bps none)
    (ok true)
  )
)

(define-public (queue-fee-recipient (new-value principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (var-set pending-fee-recipient (some { value: new-value, executable-at: (+ stacks-block-height TIMELOCK-DELAY-BLOCKS) }))
    (ok true)
  )
)
(define-public (confirm-fee-recipient)
  (let ((pending (unwrap! (var-get pending-fee-recipient) ERR-NOTHING-QUEUED)))
    (asserts! (>= stacks-block-height (get executable-at pending)) ERR-NOT-YET-EXECUTABLE)
    (var-set fee-recipient (get value pending))
    (var-set pending-fee-recipient none)
    (ok true)
  )
)

;; Admin succession: timelock AND a two-step accept, closing the existing receiver contract's
;; "single owner, no succession plan" audit finding properly for a contract about to hold
;; third-party funds. accept-admin-change is gated to the PROPOSED principal specifically
;; (unlike the anyone-can-confirm pattern above) -- accepting control is the one step that
;; should stay gated to the recipient, and it also guards against a typo'd principal
;; permanently bricking admin control.
(define-public (queue-admin-change (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (var-set pending-admin (some { value: new-admin, executable-at: (+ stacks-block-height TIMELOCK-DELAY-BLOCKS) }))
    (ok true)
  )
)
(define-public (accept-admin-change)
  (let ((pending (unwrap! (var-get pending-admin) ERR-NOTHING-QUEUED)))
    (asserts! (is-eq tx-sender (get value pending)) ERR-NOT-PENDING-ADMIN)
    (asserts! (>= stacks-block-height (get executable-at pending)) ERR-NOT-YET-EXECUTABLE)
    (var-set admin (get value pending))
    (var-set pending-admin none)
    (ok true)
  )
)

;; =============================================
;; Read-only getters
;; =============================================

(define-read-only (get-admin) (ok (var-get admin)))
(define-read-only (get-max-tvl) (ok (var-get max-tvl)))
(define-read-only (get-performance-fee-bps) (ok (var-get performance-fee-bps)))
(define-read-only (get-fee-recipient) (ok (var-get fee-recipient)))
(define-read-only (get-deposits-paused) (ok (var-get deposits-paused)))
(define-read-only (get-strategy-paused) (ok (var-get strategy-paused)))
(define-read-only (get-total-stx-balance) (ok (var-get total-stx-balance)))
(define-read-only (get-capital-at-strategy) (ok (var-get capital-at-strategy)))
(define-read-only (get-total-pending-withdrawals) (ok (var-get total-pending-withdrawals)))
(define-read-only (get-cumulative-realized-pnl) (ok (var-get cumulative-realized-pnl)))
(define-read-only (get-high-water-mark) (ok (var-get realized-pnl-high-water-mark)))
(define-read-only (get-withdrawal-request (id uint)) (ok (map-get? withdrawal-requests id)))
(define-read-only (get-pending-max-tvl) (ok (var-get pending-max-tvl)))
(define-read-only (get-pending-fee-bps) (ok (var-get pending-fee-bps)))
(define-read-only (get-pending-fee-recipient) (ok (var-get pending-fee-recipient)))
(define-read-only (get-pending-admin) (ok (var-get pending-admin)))
