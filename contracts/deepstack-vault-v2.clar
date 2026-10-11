;; deepstack-vault-v2 -- epoch-settled STX vault for DeepStack.
;;
;; STATUS: NOT DEPLOYED. Implements docs/VAULT_V2_DESIGN.md (approved by the independent
;; reviewer 2026-10-11, D1-D13). Section numbers below refer to that note. Testnet and a
;; re-review come before any mainnet deploy.
;;
;; Roles (section 2): admin (a native multisig on mainnet) sweeps and governs; the strategy
;; address alone returns capital; the guardian (the agent's hot key) can only pause; anyone can
;; settle an overdue epoch and confirm a matured timelocked change.
;;
;; States (section 3): IDLE (no capital out, exact NAV, deposits and withdrawal requests price
;; immediately) and DEPLOYED (an epoch is open, deposits and withdrawal requests queue and are
;; priced when the epoch settles, after the result is known).
;;
;; Accounting (section 4):
;;   A = vault-stx + capital-at-strategy - pending-deposits - ringfenced
;;   S = the share token's real total supply (includes escrowed shares)
;; Prices always carry the virtual offset VA = 1 uSTX, VS = 1000 share units (section 8).

(define-constant DEPLOYER tx-sender)

(define-constant SCALE u1000000000000000000) ;; 1e18 fixed point for prices (decision 7)
(define-constant VA u1)                      ;; virtual assets, uSTX
(define-constant VS u1000)                   ;; virtual shares, share units (9 decimals)
(define-constant BPS u10000)
(define-constant INITIAL-PPS (/ (* VA SCALE) VS))

(define-constant MAX-EPOCH u432)             ;; burn blocks, about 3 days (decision 3)
(define-constant TIMELOCK u1008)             ;; burn blocks, about 7 days
(define-constant WITHDRAWAL-DELAY u288)      ;; burn blocks, about 2 days, IDLE requests
(define-constant MAX-FEE-BPS u2000)          ;; 20% hard ceiling
(define-constant MAX-DEPLOY-CEILING-BPS u8000) ;; 80% hard ceiling on the sweep cap

(define-constant ERR-NOT-ADMIN            (err u300))
(define-constant ERR-NOT-STRATEGY         (err u301))
(define-constant ERR-NOT-GUARDIAN         (err u302))
(define-constant ERR-NOT-DEPLOYER         (err u303))
(define-constant ERR-ALREADY-INITIALIZED  (err u304))
(define-constant ERR-NOT-INITIALIZED      (err u305))
(define-constant ERR-DEPOSITS-PAUSED      (err u306))
(define-constant ERR-SWEEPS-PAUSED        (err u307))
(define-constant ERR-ZERO-AMOUNT          (err u308))
(define-constant ERR-OVER-CAP             (err u309))
(define-constant ERR-NOT-IDLE             (err u310))
(define-constant ERR-NOT-DEPLOYED         (err u311))
(define-constant ERR-OVER-SWEEP-CAP       (err u312))
(define-constant ERR-DRAWDOWN-BLOCK       (err u313))
(define-constant ERR-CHANGE-PENDING       (err u314))
(define-constant ERR-NOT-OVERDUE          (err u315))
(define-constant ERR-NOT-FOUND            (err u316))
(define-constant ERR-NOT-OWNER            (err u317))
(define-constant ERR-NOT-YET-CLAIMABLE    (err u318))
(define-constant ERR-NOT-SETTLED          (err u319))
(define-constant ERR-NOTHING-QUEUED       (err u321))
(define-constant ERR-NOT-YET-EXECUTABLE   (err u322))
(define-constant ERR-NOT-PENDING-ADMIN    (err u323))
(define-constant ERR-TOO-HIGH             (err u324))
(define-constant ERR-ZERO-VALUE           (err u325))

;; ---------------------------------------------------------------------------
;; State
;; ---------------------------------------------------------------------------

(define-data-var initialized bool false)
(define-data-var admin principal DEPLOYER)
(define-data-var strategy principal DEPLOYER)
(define-data-var guardian principal DEPLOYER)
(define-data-var fee-recipient principal DEPLOYER)

(define-data-var max-tvl uint u500000000)      ;; 500 STX pilot cap, includes queued deposits (D8)
(define-data-var fee-bps uint u1000)           ;; 10%
(define-data-var max-deploy-bps uint u5000)    ;; 50% of settled assets per sweep (decision 2)

(define-data-var deposits-paused bool false)
(define-data-var sweeps-paused bool false)

;; Ledger (uSTX). vault-stx is everything the contract holds by its own accounting; it never
;; reads stx-get-balance, so a donation cannot move any price.
(define-data-var vault-stx uint u0)
(define-data-var capital-at-strategy uint u0)
(define-data-var pending-deposits uint u0)     ;; queued deposit STX, never in A, never swept
(define-data-var ringfenced uint u0)           ;; owed to settled exits and refunds, never in A

(define-data-var realized-pnl int 0)
(define-data-var hwm-pps uint INITIAL-PPS)     ;; per-share high-water mark (M1)
(define-data-var sweep-ref-pps uint INITIAL-PPS) ;; drawdown reference (D13)

(define-data-var current-epoch uint u0)
(define-data-var epoch-open bool false)
(define-data-var next-request-id uint u0)

(define-map epochs uint {
  start-burn: uint,
  deployed: uint,
  dep-total: uint,
  wd-shares-total: uint,
  settled: bool,
  dep-shares-minted: uint,
  wd-stx-paid: uint,
  written-off: bool,
})
(define-map epoch-deposits { epoch: uint, user: principal } uint)
(define-map epoch-withdrawals { epoch: uint, user: principal } uint)
(define-map requests uint { owner: principal, amount: uint, claimable-at: uint })

;; Timelocked changes (section 7). No cancel; re-queuing restarts the clock.
(define-data-var pending-max-tvl (optional { value: uint, executable-at: uint }) none)
(define-data-var pending-fee-bps (optional { value: uint, executable-at: uint }) none)
(define-data-var pending-max-deploy-bps (optional { value: uint, executable-at: uint }) none)
(define-data-var pending-fee-recipient (optional { value: principal, executable-at: uint }) none)
(define-data-var pending-strategy (optional { value: principal, executable-at: uint }) none)
(define-data-var pending-guardian (optional { value: principal, executable-at: uint }) none)
(define-data-var pending-admin (optional { value: principal, executable-at: uint }) none)
(define-data-var pending-resume (optional uint) none)

;; ---------------------------------------------------------------------------
;; Read-only accounting
;; ---------------------------------------------------------------------------

(define-read-only (get-supply)
  (unwrap-panic (contract-call? .deepstack-vault-v2-token get-total-supply))
)

(define-read-only (total-assets)
  (- (+ (var-get vault-stx) (var-get capital-at-strategy))
     (+ (var-get pending-deposits) (var-get ringfenced)))
)

(define-read-only (get-pps)
  (/ (* (+ (total-assets) VA) SCALE) (+ (get-supply) VS))
)

(define-read-only (shares-for-assets (assets uint))
  (/ (* assets (+ (get-supply) VS)) (+ (total-assets) VA))
)

(define-read-only (assets-for-shares (shares uint))
  (/ (* shares (+ (total-assets) VA)) (+ (get-supply) VS))
)

(define-read-only (get-epoch (id uint)) (map-get? epochs id))
(define-read-only (get-epoch-deposit (id uint) (user principal)) (default-to u0 (map-get? epoch-deposits { epoch: id, user: user })))
(define-read-only (get-epoch-withdrawal (id uint) (user principal)) (default-to u0 (map-get? epoch-withdrawals { epoch: id, user: user })))
(define-read-only (get-request (id uint)) (map-get? requests id))

(define-read-only (is-overdue)
  (match (map-get? epochs (var-get current-epoch))
    ep (and (var-get epoch-open) (> burn-block-height (+ (get start-burn ep) MAX-EPOCH)))
    false)
)

(define-read-only (no-change-pending)
  (and (is-none (var-get pending-max-tvl)) (is-none (var-get pending-fee-bps))
       (is-none (var-get pending-max-deploy-bps)) (is-none (var-get pending-fee-recipient))
       (is-none (var-get pending-strategy)) (is-none (var-get pending-guardian))
       (is-none (var-get pending-admin)) (is-none (var-get pending-resume)))
)

(define-read-only (get-state)
  {
    initialized: (var-get initialized), admin: (var-get admin), strategy: (var-get strategy),
    guardian: (var-get guardian), fee-recipient: (var-get fee-recipient),
    max-tvl: (var-get max-tvl), fee-bps: (var-get fee-bps), max-deploy-bps: (var-get max-deploy-bps),
    deposits-paused: (var-get deposits-paused), sweeps-paused: (var-get sweeps-paused),
    vault-stx: (var-get vault-stx), capital-at-strategy: (var-get capital-at-strategy),
    pending-deposits: (var-get pending-deposits), ringfenced: (var-get ringfenced),
    total-assets: (total-assets), supply: (get-supply), pps: (get-pps),
    hwm-pps: (var-get hwm-pps), sweep-ref-pps: (var-get sweep-ref-pps),
    realized-pnl: (var-get realized-pnl), current-epoch: (var-get current-epoch),
    epoch-open: (var-get epoch-open), overdue: (is-overdue), no-change-pending: (no-change-pending),
  }
)

(define-read-only (get-pending-changes)
  {
    max-tvl: (var-get pending-max-tvl), fee-bps: (var-get pending-fee-bps),
    max-deploy-bps: (var-get pending-max-deploy-bps), fee-recipient: (var-get pending-fee-recipient),
    strategy: (var-get pending-strategy), guardian: (var-get pending-guardian),
    admin: (var-get pending-admin), resume: (var-get pending-resume),
  }
)

;; ---------------------------------------------------------------------------
;; Setup: one-time role assignment by the deployer, before anything else can happen
;; ---------------------------------------------------------------------------

(define-public (initialize (new-admin principal) (new-strategy principal) (new-guardian principal) (new-fee-recipient principal))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR-NOT-DEPLOYER)
    (asserts! (not (var-get initialized)) ERR-ALREADY-INITIALIZED)
    (var-set admin new-admin)
    (var-set strategy new-strategy)
    (var-set guardian new-guardian)
    (var-set fee-recipient new-fee-recipient)
    (var-set initialized true)
    (print { event: "initialized", admin: new-admin, strategy: new-strategy, guardian: new-guardian, fee-recipient: new-fee-recipient })
    (ok true)
  )
)

;; ---------------------------------------------------------------------------
;; Deposits
;; ---------------------------------------------------------------------------

(define-public (deposit (amount uint))
  (let ((user tx-sender))
    (asserts! (var-get initialized) ERR-NOT-INITIALIZED)
    (asserts! (not (var-get deposits-paused)) ERR-DEPOSITS-PAUSED)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    ;; Queued deposits count toward the cap (D8).
    (asserts! (<= (+ (total-assets) (var-get pending-deposits) amount) (var-get max-tvl)) ERR-OVER-CAP)
    (if (var-get epoch-open)
      (let ((e (var-get current-epoch)) (ep (unwrap! (map-get? epochs e) ERR-NOT-FOUND)))
        (try! (stx-transfer? amount user (as-contract tx-sender)))
        (var-set vault-stx (+ (var-get vault-stx) amount))
        (var-set pending-deposits (+ (var-get pending-deposits) amount))
        (map-set epochs e (merge ep { dep-total: (+ (get dep-total ep) amount) }))
        (map-set epoch-deposits { epoch: e, user: user } (+ (get-epoch-deposit e user) amount))
        (print { event: "deposit-queued", user: user, epoch: e, amount: amount })
        (ok u0))
      (let ((shares (shares-for-assets amount)))
        (asserts! (> shares u0) ERR-ZERO-VALUE)
        (try! (stx-transfer? amount user (as-contract tx-sender)))
        (var-set vault-stx (+ (var-get vault-stx) amount))
        (try! (as-contract (contract-call? .deepstack-vault-v2-token mint-for-vault shares user)))
        (print { event: "deposit", user: user, amount: amount, shares: shares })
        (ok shares)))
  )
)

;; Cancel this user's queued deposit in the open epoch (D4: only before settlement).
(define-public (cancel-deposit)
  (let ((user tx-sender) (e (var-get current-epoch)) (amount (get-epoch-deposit (var-get current-epoch) tx-sender)))
    (asserts! (var-get epoch-open) ERR-NOT-DEPLOYED)
    (asserts! (> amount u0) ERR-NOT-FOUND)
    (let ((ep (unwrap! (map-get? epochs e) ERR-NOT-FOUND)))
      (map-delete epoch-deposits { epoch: e, user: user })
      (map-set epochs e (merge ep { dep-total: (- (get dep-total ep) amount) }))
      (var-set pending-deposits (- (var-get pending-deposits) amount))
      (var-set vault-stx (- (var-get vault-stx) amount))
      (try! (as-contract (stx-transfer? amount tx-sender user)))
      (print { event: "deposit-cancelled", user: user, epoch: e, amount: amount })
      (ok amount))
  )
)

;; Claim a settled epoch's deposit: shares from the vault's escrow, or a 1:1 STX refund if the
;; epoch was written off (D12). The record is deleted even if the claim rounds to 0 (D4).
(define-public (claim-deposit (e uint))
  (let ((user tx-sender)
        (ep (unwrap! (map-get? epochs e) ERR-NOT-FOUND))
        (amount (get-epoch-deposit e tx-sender)))
    (asserts! (get settled ep) ERR-NOT-SETTLED)
    (asserts! (> amount u0) ERR-NOT-FOUND)
    (map-delete epoch-deposits { epoch: e, user: user })
    (if (get written-off ep)
      (begin
        (var-set ringfenced (- (var-get ringfenced) amount))
        (var-set vault-stx (- (var-get vault-stx) amount))
        (try! (as-contract (stx-transfer? amount tx-sender user)))
        (print { event: "deposit-refunded", user: user, epoch: e, amount: amount })
        (ok amount))
      (let ((shares (/ (* amount (get dep-shares-minted ep)) (get dep-total ep))))
        (if (> shares u0)
          (try! (as-contract (contract-call? .deepstack-vault-v2-token transfer shares tx-sender user none)))
          true)
        (print { event: "deposit-claimed", user: user, epoch: e, shares: shares })
        (ok shares)))
  )
)

;; ---------------------------------------------------------------------------
;; Withdrawals
;; ---------------------------------------------------------------------------

;; IDLE: priced now, shares burned now, payout ring-fenced, claimable after the delay (D3).
;; DEPLOYED: shares escrowed and priced when the epoch settles.
(define-public (request-withdrawal (shares uint))
  (let ((user tx-sender))
    (asserts! (> shares u0) ERR-ZERO-AMOUNT)
    (if (var-get epoch-open)
      (let ((e (var-get current-epoch)) (ep (unwrap! (map-get? epochs e) ERR-NOT-FOUND)))
        (try! (contract-call? .deepstack-vault-v2-token transfer shares user (as-contract tx-sender) none))
        (map-set epochs e (merge ep { wd-shares-total: (+ (get wd-shares-total ep) shares) }))
        (map-set epoch-withdrawals { epoch: e, user: user } (+ (get-epoch-withdrawal e user) shares))
        (print { event: "withdrawal-queued", user: user, epoch: e, shares: shares })
        (ok { queued: true, id: e }))
      (let ((payout (assets-for-shares shares)) (id (var-get next-request-id)))
        (asserts! (> payout u0) ERR-ZERO-VALUE)
        (try! (as-contract (contract-call? .deepstack-vault-v2-token burn-for-vault shares user)))
        (var-set ringfenced (+ (var-get ringfenced) payout))
        (map-set requests id { owner: user, amount: payout, claimable-at: (+ burn-block-height WITHDRAWAL-DELAY) })
        (var-set next-request-id (+ id u1))
        (print { event: "withdrawal-requested", user: user, id: id, shares: shares, amount: payout })
        (ok { queued: false, id: id })))
  )
)

(define-public (claim-withdrawal (id uint))
  (let ((user tx-sender) (req (unwrap! (map-get? requests id) ERR-NOT-FOUND)))
    (asserts! (is-eq (get owner req) user) ERR-NOT-OWNER)
    (asserts! (>= burn-block-height (get claimable-at req)) ERR-NOT-YET-CLAIMABLE)
    (map-delete requests id)
    (var-set ringfenced (- (var-get ringfenced) (get amount req)))
    (var-set vault-stx (- (var-get vault-stx) (get amount req)))
    (try! (as-contract (stx-transfer? (get amount req) tx-sender user)))
    (print { event: "withdrawal-claimed", user: user, id: id, amount: (get amount req) })
    (ok (get amount req))
  )
)

(define-public (cancel-withdrawal)
  (let ((user tx-sender) (e (var-get current-epoch)) (shares (get-epoch-withdrawal (var-get current-epoch) tx-sender)))
    (asserts! (var-get epoch-open) ERR-NOT-DEPLOYED)
    (asserts! (> shares u0) ERR-NOT-FOUND)
    (let ((ep (unwrap! (map-get? epochs e) ERR-NOT-FOUND)))
      (map-delete epoch-withdrawals { epoch: e, user: user })
      (map-set epochs e (merge ep { wd-shares-total: (- (get wd-shares-total ep) shares) }))
      (try! (as-contract (contract-call? .deepstack-vault-v2-token transfer shares tx-sender user none)))
      (print { event: "withdrawal-cancelled", user: user, epoch: e, shares: shares })
      (ok shares))
  )
)

(define-public (claim-epoch-withdrawal (e uint))
  (let ((user tx-sender)
        (ep (unwrap! (map-get? epochs e) ERR-NOT-FOUND))
        (shares (get-epoch-withdrawal e tx-sender)))
    (asserts! (get settled ep) ERR-NOT-SETTLED)
    (asserts! (> shares u0) ERR-NOT-FOUND)
    (map-delete epoch-withdrawals { epoch: e, user: user })
    (let ((amount (/ (* shares (get wd-stx-paid ep)) (get wd-shares-total ep))))
      (if (> amount u0)
        (begin
          (var-set ringfenced (- (var-get ringfenced) amount))
          (var-set vault-stx (- (var-get vault-stx) amount))
          (try! (as-contract (stx-transfer? amount tx-sender user))))
        true)
      (print { event: "epoch-withdrawal-claimed", user: user, epoch: e, amount: amount })
      (ok amount))
  )
)

;; ---------------------------------------------------------------------------
;; Strategy round trip
;; ---------------------------------------------------------------------------

(define-public (sweep (amount uint))
  (let ((e (var-get current-epoch)))
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (var-get initialized) ERR-NOT-INITIALIZED)
    (asserts! (not (var-get epoch-open)) ERR-NOT-IDLE)
    (asserts! (not (var-get sweeps-paused)) ERR-SWEEPS-PAUSED)
    (asserts! (no-change-pending) ERR-CHANGE-PENDING)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (asserts! (<= amount (/ (* (total-assets) (var-get max-deploy-bps)) BPS)) ERR-OVER-SWEEP-CAP)
    ;; Drawdown block (D5/D13): PPS must be within 10% of the reference, in integers.
    (asserts! (>= (* (get-pps) u10) (* (var-get sweep-ref-pps) u9)) ERR-DRAWDOWN-BLOCK)
    (var-set vault-stx (- (var-get vault-stx) amount))
    (var-set capital-at-strategy amount)
    (map-set epochs e {
      start-burn: burn-block-height, deployed: amount, dep-total: u0, wd-shares-total: u0,
      settled: false, dep-shares-minted: u0, wd-stx-paid: u0, written-off: false,
    })
    (var-set epoch-open true)
    (try! (as-contract (stx-transfer? amount tx-sender (var-get strategy))))
    (print { event: "sweep", epoch: e, amount: amount, strategy: (var-get strategy) })
    (ok e)
  )
)

;; Only the strategy address returns capital (section 2). A return of 0 is allowed (D1).
;; Still works while overdue reads true, until someone calls settle-overdue.
(define-public (return-from-strategy (returned uint))
  (begin
    (asserts! (is-eq tx-sender (var-get strategy)) ERR-NOT-STRATEGY)
    (asserts! (var-get epoch-open) ERR-NOT-DEPLOYED)
    (if (> returned u0)
      (try! (stx-transfer? returned tx-sender (as-contract tx-sender)))
      true)
    (var-set vault-stx (+ (var-get vault-stx) returned))
    (settle returned false)
  )
)

;; Anyone, once MAX-EPOCH burn blocks have passed: settle as a return of 0 (D1), refund the
;; queued deposits and pause deposits (D12).
(define-public (settle-overdue)
  (begin
    (asserts! (var-get epoch-open) ERR-NOT-DEPLOYED)
    (asserts! (is-overdue) ERR-NOT-OVERDUE)
    (settle u0 true)
  )
)

;; Late STX from the strategy after a write-off (D1). Raises A for the holders at that time.
(define-public (recover-from-strategy (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get strategy)) ERR-NOT-STRATEGY)
    (asserts! (not (var-get epoch-open)) ERR-NOT-IDLE)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    (var-set vault-stx (+ (var-get vault-stx) amount))
    (var-set realized-pnl (+ (var-get realized-pnl) (to-int amount)))
    (print { event: "recovered", amount: amount })
    (ok amount)
  )
)

;; Section 5, in order: book P&L, fee, price withdrawals, then deposits (or refund them).
(define-private (settle (returned uint) (writeoff bool))
  (let (
    (e (var-get current-epoch))
    (ep (unwrap! (map-get? epochs e) ERR-NOT-FOUND))
    (deployed (var-get capital-at-strategy))
  )
    ;; 1. P&L
    (var-set capital-at-strategy u0)
    (var-set realized-pnl (+ (var-get realized-pnl) (- (to-int returned) (to-int deployed))))
    (let (
      (s0 (get-supply))
      (a0 (total-assets))
      (pps-pre (/ (* (+ a0 VA) SCALE) (+ s0 VS)))
      (hwm (var-get hwm-pps))
      ;; 2. Fee on the per-share gain above the high-water mark, rounded down (L1, M1, D6)
      (gain (if (> pps-pre hwm) (/ (* (- pps-pre hwm) (+ s0 VS)) SCALE) u0))
      (fee (/ (* gain (var-get fee-bps)) BPS))
      (fee-shares (if (and (> fee u0) (< fee (+ a0 VA))) (/ (* fee (+ s0 VS)) (- (+ a0 VA) fee)) u0))
      (s1 (+ s0 fee-shares))
      (post-pps (/ (* (+ a0 VA) SCALE) (+ s1 VS)))
      (post-pps-up (/ (- (+ (* (+ a0 VA) SCALE) (+ s1 VS)) u1) (+ s1 VS)))
      ;; 3. Queued withdrawals at the post-fee price
      (wd (get wd-shares-total ep))
      (wd-stx (/ (* wd (+ a0 VA)) (+ s1 VS)))
      ;; 4. Queued deposits at the post-withdrawal price (or refunded on a write-off)
      (dep (get dep-total ep))
      (a2 (- a0 wd-stx))
      (s2 (- s1 wd))
      (minted (if writeoff u0 (/ (* dep (+ s2 VS)) (+ a2 VA))))
    )
      (if (> fee-shares u0)
        (try! (as-contract (contract-call? .deepstack-vault-v2-token mint-for-vault fee-shares (var-get fee-recipient))))
        true)
      (if (> pps-pre hwm) (var-set hwm-pps post-pps-up) true)
      (if (> post-pps (var-get sweep-ref-pps)) (var-set sweep-ref-pps post-pps) true)
      (if (> wd u0)
        (begin
          (try! (as-contract (contract-call? .deepstack-vault-v2-token burn-for-vault wd tx-sender)))
          (var-set ringfenced (+ (var-get ringfenced) wd-stx)))
        true)
      (var-set pending-deposits (- (var-get pending-deposits) dep))
      (if writeoff
        (begin
          (var-set ringfenced (+ (var-get ringfenced) dep))
          (var-set deposits-paused true))
        (if (> minted u0)
          (try! (as-contract (contract-call? .deepstack-vault-v2-token mint-for-vault minted tx-sender)))
          true))
      ;; 5. Close the epoch
      (map-set epochs e (merge ep {
        settled: true, dep-shares-minted: minted, wd-stx-paid: wd-stx, written-off: writeoff,
      }))
      (var-set epoch-open false)
      (var-set current-epoch (+ e u1))
      (print {
        event: "settled", epoch: e, returned: returned, deployed: deployed, written-off: writeoff,
        fee: fee, fee-shares: fee-shares, pps-pre: pps-pre, pps-post: post-pps, hwm-pps: (var-get hwm-pps),
        wd-shares: wd, wd-stx: wd-stx, dep-total: dep, dep-shares-minted: minted,
      })
      (ok e))
  )
)

;; ---------------------------------------------------------------------------
;; Pause (guardian or admin) / unpause (admin only)
;; ---------------------------------------------------------------------------

(define-private (is-guardian-or-admin)
  (or (is-eq tx-sender (var-get guardian)) (is-eq tx-sender (var-get admin))))

(define-public (pause-deposits)
  (begin (asserts! (is-guardian-or-admin) ERR-NOT-GUARDIAN)
    (var-set deposits-paused true) (print { event: "deposits-paused" }) (ok true)))
(define-public (pause-sweeps)
  (begin (asserts! (is-guardian-or-admin) ERR-NOT-GUARDIAN)
    (var-set sweeps-paused true) (print { event: "sweeps-paused" }) (ok true)))
(define-public (unpause-deposits)
  (begin (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (var-set deposits-paused false) (print { event: "deposits-unpaused" }) (ok true)))
(define-public (unpause-sweeps)
  (begin (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (var-set sweeps-paused false) (print { event: "sweeps-unpaused" }) (ok true)))

;; ---------------------------------------------------------------------------
;; Timelock (section 7): admin queues while IDLE, anyone confirms after TIMELOCK burn blocks,
;; except admin succession, which the proposed admin must accept.
;; ---------------------------------------------------------------------------

(define-private (check-queue)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR-NOT-ADMIN)
    (asserts! (not (var-get epoch-open)) ERR-NOT-IDLE)
    (ok (+ burn-block-height TIMELOCK))))

(define-public (queue-max-tvl (v uint))
  (let ((at (try! (check-queue))))
    (var-set pending-max-tvl (some { value: v, executable-at: at }))
    (print { event: "queued", param: "max-tvl", value: v, executable-at: at }) (ok at)))
(define-public (queue-fee-bps (v uint))
  (let ((at (try! (check-queue))))
    (asserts! (<= v MAX-FEE-BPS) ERR-TOO-HIGH)
    (var-set pending-fee-bps (some { value: v, executable-at: at }))
    (print { event: "queued", param: "fee-bps", value: v, executable-at: at }) (ok at)))
(define-public (queue-max-deploy-bps (v uint))
  (let ((at (try! (check-queue))))
    (asserts! (and (> v u0) (<= v MAX-DEPLOY-CEILING-BPS)) ERR-TOO-HIGH)
    (var-set pending-max-deploy-bps (some { value: v, executable-at: at }))
    (print { event: "queued", param: "max-deploy-bps", value: v, executable-at: at }) (ok at)))
(define-public (queue-fee-recipient (v principal))
  (let ((at (try! (check-queue))))
    (var-set pending-fee-recipient (some { value: v, executable-at: at }))
    (print { event: "queued", param: "fee-recipient", value: v, executable-at: at }) (ok at)))
(define-public (queue-strategy (v principal))
  (let ((at (try! (check-queue))))
    (var-set pending-strategy (some { value: v, executable-at: at }))
    (print { event: "queued", param: "strategy", value: v, executable-at: at }) (ok at)))
(define-public (queue-guardian (v principal))
  (let ((at (try! (check-queue))))
    (var-set pending-guardian (some { value: v, executable-at: at }))
    (print { event: "queued", param: "guardian", value: v, executable-at: at }) (ok at)))
(define-public (queue-admin-change (v principal))
  (let ((at (try! (check-queue))))
    (var-set pending-admin (some { value: v, executable-at: at }))
    (print { event: "queued", param: "admin", value: v, executable-at: at }) (ok at)))
(define-public (queue-resume-sweeps)
  (let ((at (try! (check-queue))))
    (var-set pending-resume (some at))
    (print { event: "queued", param: "resume-sweeps", executable-at: at }) (ok at)))

(define-private (matured (at uint))
  (begin
    (asserts! (not (var-get epoch-open)) ERR-NOT-IDLE)
    (asserts! (>= burn-block-height at) ERR-NOT-YET-EXECUTABLE)
    (ok true)))

(define-public (confirm-max-tvl)
  (let ((p (unwrap! (var-get pending-max-tvl) ERR-NOTHING-QUEUED)))
    (try! (matured (get executable-at p)))
    (var-set max-tvl (get value p)) (var-set pending-max-tvl none)
    (print { event: "confirmed", param: "max-tvl", value: (get value p) }) (ok true)))
(define-public (confirm-fee-bps)
  (let ((p (unwrap! (var-get pending-fee-bps) ERR-NOTHING-QUEUED)))
    (try! (matured (get executable-at p)))
    (var-set fee-bps (get value p)) (var-set pending-fee-bps none)
    (print { event: "confirmed", param: "fee-bps", value: (get value p) }) (ok true)))
(define-public (confirm-max-deploy-bps)
  (let ((p (unwrap! (var-get pending-max-deploy-bps) ERR-NOTHING-QUEUED)))
    (try! (matured (get executable-at p)))
    (var-set max-deploy-bps (get value p)) (var-set pending-max-deploy-bps none)
    (print { event: "confirmed", param: "max-deploy-bps", value: (get value p) }) (ok true)))
(define-public (confirm-fee-recipient)
  (let ((p (unwrap! (var-get pending-fee-recipient) ERR-NOTHING-QUEUED)))
    (try! (matured (get executable-at p)))
    (var-set fee-recipient (get value p)) (var-set pending-fee-recipient none)
    (print { event: "confirmed", param: "fee-recipient", value: (get value p) }) (ok true)))
(define-public (confirm-strategy)
  (let ((p (unwrap! (var-get pending-strategy) ERR-NOTHING-QUEUED)))
    (try! (matured (get executable-at p)))
    (var-set strategy (get value p)) (var-set pending-strategy none)
    (print { event: "confirmed", param: "strategy", value: (get value p) }) (ok true)))
(define-public (confirm-guardian)
  (let ((p (unwrap! (var-get pending-guardian) ERR-NOTHING-QUEUED)))
    (try! (matured (get executable-at p)))
    (var-set guardian (get value p)) (var-set pending-guardian none)
    (print { event: "confirmed", param: "guardian", value: (get value p) }) (ok true)))
(define-public (accept-admin-change)
  (let ((p (unwrap! (var-get pending-admin) ERR-NOTHING-QUEUED)))
    (asserts! (is-eq tx-sender (get value p)) ERR-NOT-PENDING-ADMIN)
    (try! (matured (get executable-at p)))
    (var-set admin (get value p)) (var-set pending-admin none)
    (print { event: "confirmed", param: "admin", value: (get value p) }) (ok true)))
;; D13: a confirmed resume resets the drawdown reference to the price now. HWM-PPS is untouched.
(define-public (confirm-resume-sweeps)
  (let ((at (unwrap! (var-get pending-resume) ERR-NOTHING-QUEUED)))
    (try! (matured at))
    (var-set sweep-ref-pps (get-pps)) (var-set pending-resume none)
    (print { event: "confirmed", param: "resume-sweeps", sweep-ref-pps: (get-pps) }) (ok true)))
