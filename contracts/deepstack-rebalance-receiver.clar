;; DeepStack Flash-Rebalance Receiver -- DRAFT, NOT YET DEPLOYED
;;
;; The DeepStack <-> FlashStack integration (M2 deliverable): borrow STX from
;; flashstack-stx-core, buy sBTC on the Bitflow XYK sBTC-STX pool at a size larger
;; than free inventory allows, forward the sBTC to the operator, and repay
;; amount + fee from the operator's wallet -- all in ONE atomic transaction.
;; If any leg fails (swap slippage, repayment), the whole transaction reverts and
;; only the network fee is lost. The operator's own inventory is the second leg:
;; a market maker repays from what it holds, no second venue required.
;;
;; Flow (two transactions):
;;   tx1  arm(amount, min-dx)          -- operator quotes get-dx off-chain, sets a REAL
;;                                       min-out (never u1), armed trade expires in 10 blocks
;;   tx2  flashstack-stx-core.flash-loan(amount, .deepstack-rebalance-receiver)
;;        `- core sends STX -> execute-stx-flash -> swap-y-for-x(min-dx) -> sBTC to
;;           operator -> repay amount+fee from operator wallet -> core asserts reserve
;;
;; Discipline differences vs the earlier FlashStack receivers, on purpose:
;;   - min-out is a required, armed parameter (the bitflow-arb template used u1 floors
;;     and leaned on the repay assert; DeepStack never submits a write with min = 0)
;;   - one-shot arming with block expiry -- a stale min-dx cannot be replayed later
;;   - strict auth: callback only from the core, only for operator-initiated loans
;;
;; BEFORE DEPLOYING (operator checklist):
;;   1. Verify the live core/trait principals below against the FlashStack deployment.
;;   2. Deploy this contract FROM THE OPERATOR (agent) WALLET -- CONTRACT-OWNER binds to
;;      the deployer, and repayment is drawn from tx-sender (must be the operator).
;;   3. Whitelist this contract on flashstack-stx-core (approved-receivers, owner call).
;;   4. First live run: tiny amount, Allow-mode post-conditions capping the STX outflow
;;      from the operator wallet at amount + fee + network fee.

(impl-trait 'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

;; =============================================
;; Constants -- all mainnet, verify before deploy
;; =============================================

(define-constant CONTRACT-OWNER tx-sender) ;; the operator (agent) wallet

;; Live FlashStack core (all FlashStack contracts deploy under SP20XD46...; the receiver
;; TRAIT lives under SP3TGRVG... -- see FlashStack docs/BUILD_A_RECEIVER.md). Used for the
;; caller check only; contract-call targets and trait arguments below are written as
;; inline literals because define-constant principals fail Clarity's static analysis
;; in trait-argument position (BUILD_A_RECEIVER.md, rule 3).
(define-constant FLASHSTACK-CORE 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)

(define-constant ARM-TTL-BLOCKS u10) ;; a quoted min-dx goes stale; ~10 blocks is minutes

(define-constant ERR-NOT-OWNER       (err u400))
(define-constant ERR-NOT-ARMED       (err u401))
(define-constant ERR-ARM-EXPIRED     (err u402))
(define-constant ERR-UNAUTHORIZED    (err u403))
(define-constant ERR-AMOUNT-MISMATCH (err u404))
(define-constant ERR-BAD-PARAMS      (err u405))
(define-constant ERR-FEE-READ        (err u406))
(define-constant ERR-SWAP-FAILED     (err u407))
(define-constant ERR-TRANSFER-FAILED (err u408))
(define-constant ERR-REPAY-FAILED    (err u409))

;; =============================================
;; One-shot armed trade
;; =============================================

(define-data-var pending
  (optional { amount: uint, min-dx: uint, expires: uint })
  none)

;; Arm the next flash-rebalance. min-dx MUST come from a fresh off-chain get-dx quote
;; minus the slippage budget -- that is the guard that makes the swap leg honest.
(define-public (arm (amount uint) (min-dx uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (asserts! (and (> amount u0) (> min-dx u0)) ERR-BAD-PARAMS)
    (ok (var-set pending
      (some { amount: amount, min-dx: min-dx, expires: (+ stacks-block-height ARM-TTL-BLOCKS) })))
  )
)

(define-public (disarm)
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (ok (var-set pending none))
  )
)

;; =============================================
;; Flash loan callback
;; =============================================

(define-public (execute-stx-flash (amount uint) (core principal))
  (let (
    (trade (unwrap! (var-get pending) ERR-NOT-ARMED))
  )
    ;; One-shot: consumed on success; a reverted transaction rolls this back, so a
    ;; failed attempt stays armed until it succeeds, expires, or is disarmed.
    (var-set pending none)

    ;; Auth: only the FlashStack core, mid-loan, on a loan the operator initiated.
    (asserts! (is-eq contract-caller FLASHSTACK-CORE) ERR-UNAUTHORIZED)
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-UNAUTHORIZED)
    (asserts! (is-eq amount (get amount trade)) ERR-AMOUNT-MISMATCH)
    (asserts! (<= stacks-block-height (get expires trade)) ERR-ARM-EXPIRED)

    (let (
      (fee-bp (unwrap! (contract-call? 'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core
                         get-fee-basis-points) ERR-FEE-READ))
      (raw-fee (/ (* amount fee-bp) u10000))
      (fee (if (> raw-fee u0) raw-fee u1))
      (total-owed (+ amount fee))
      (operator CONTRACT-OWNER)
    )
      ;; Leg 1: borrowed STX -> sBTC through the Bitflow core, REAL min-out enforced.
      ;; as-contract: the borrowed STX sits in this contract's balance.
      (unwrap! (as-contract (contract-call?
        'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2 swap-y-for-x
        'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
        'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
        amount (get min-dx trade))) ERR-SWAP-FAILED)

      ;; Leg 2: every sat of sBTC goes to the operator -- nothing stays in the receiver.
      (let ((got (unwrap! (contract-call?
                   'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                   get-balance (as-contract tx-sender)) ERR-SWAP-FAILED)))
        (asserts! (>= got (get min-dx trade)) ERR-SWAP-FAILED)
        (unwrap! (as-contract (contract-call?
          'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          transfer got tx-sender operator none)) ERR-TRANSFER-FAILED)

        ;; Leg 3: repay amount + fee from the OPERATOR's wallet (tx-sender here is the
        ;; operator -- the core invokes this callback outside as-contract). This is the
        ;; own-inventory second leg; if the operator can't cover it, everything reverts.
        (unwrap! (stx-transfer? total-owed tx-sender core) ERR-REPAY-FAILED)

        (print { event: "flash-rebalance", borrowed: amount, fee: fee, sbtc-out: got })
        (ok true)
      )
    )
  )
)

;; =============================================
;; Admin + read-only
;; =============================================

;; Nothing should ever be stranded here, but atomicity is a claim to verify, not assume.
(define-public (rescue-stx (amount uint) (to principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (unwrap! (as-contract (stx-transfer? amount tx-sender to)) ERR-TRANSFER-FAILED)
    (ok true)
  )
)

(define-public (rescue-sbtc (amount uint) (to principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (unwrap! (as-contract (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount tx-sender to none)) ERR-TRANSFER-FAILED)
    (ok true)
  )
)

(define-read-only (get-pending) (ok (var-get pending)))
(define-read-only (get-owner) (ok CONTRACT-OWNER))
