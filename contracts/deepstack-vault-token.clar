;; DeepStack Vault Share Token
;;
;; STATUS: NOT YET DEPLOYED. Phase 1 of the AUM vault (see docs/VAULT_DISCLOSURE.md and
;;   reports/DeepStack AUM vault architecture.md) -- proven on Clarinet's simnet first, deploy
;;   is a separate, later decision, same discipline as every other live-money step this
;;   project has taken.
;;
;; A standard SIP-010 fungible token representing shares in deepstack-vault.clar. Mint and
;; burn are restricted to the vault contract ONLY -- checked via contract-caller (the
;; immediate calling CONTRACT), not tx-sender (the human who signed), which is the deliberate
;; Clarity-native defense against principal confusion at this boundary. This mirrors the
;; audited StackingDAO (Arkadiko) pattern (github.com/StackingDAO/contracts,
;; contracts/core/ststx-token.clar) but hardcodes the single trusted caller as a one-time-set
;; value instead of consulting a shared registry contract -- Phase 1 has exactly one vault,
;; forever, in this phase, and a shared whitelist registry is exactly the pattern StackingDAO's
;; own CoinFabrik audit flagged as an added attack surface for no benefit (finding MI-04,
;; "Any Whitelisted Principal Can Disable Others").
;;
;; Chicken-and-egg deploy problem and its fix: deepstack-vault.clar calls INTO this token
;; (mint/burn/transfer), so Clarity's static analyzer requires this contract to already exist
;; on-chain before the vault can even be deployed -- meaning this contract cannot know the
;; vault's real address at ITS OWN deploy time. Fixed with a one-time link: vault-contract
;; starts as none, and only the ORIGINAL DEPLOYER of this token contract may call
;; set-vault-contract, exactly once (the second call fails closed, permanently). There is no
;; function to change it again afterward -- the link is immutable once set.
;;
;; DEPLOY RUNBOOK:
;;   1. Deploy this contract.
;;   2. Deploy deepstack-vault.clar (it hardcodes a literal reference to THIS contract, so this
;;      one must exist first).
;;   3. From the same wallet that deployed this contract, call set-vault-contract with the
;;      vault's real address. Until this step runs, mint-for-vault/burn-for-vault always fail
;;      (vault-contract is none, and (some contract-caller) can never equal none) -- the token
;;      is inert, not unsafe, in between steps 1 and 3.

(impl-trait 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.sip-010-trait-ft-standard-v-1-1.sip-010-trait)

(define-fungible-token deepstack-vault-shares)

;; =============================================
;; Constants / one-time vault link
;; =============================================

(define-constant TOKEN-DEPLOYER tx-sender) ;; whoever deploys THIS contract -- the only one
                                            ;; allowed to perform the one-time vault link below

(define-constant TOKEN-NAME "DeepStack Vault Shares")
(define-constant TOKEN-SYMBOL "dsSTX")
(define-constant TOKEN-DECIMALS u6) ;; matches STX's own 6 decimals -- the vault's accounting unit

(define-constant ERR-NOT-TOKEN-DEPLOYER  (err u200))
(define-constant ERR-VAULT-ALREADY-SET   (err u201))
(define-constant ERR-NOT-VAULT           (err u202))
(define-constant ERR-NOT-TOKEN-OWNER     (err u203))

(define-data-var vault-contract (optional principal) none)

;; One-shot: the only way deepstack-vault.clar's address is ever recorded here. No function
;; anywhere in this contract can change it once set -- re-pointing to a different vault would
;; mean deploying a new token contract, matching the "redeploy, don't mutate trust boundaries"
;; discipline used throughout this project's existing contract.
(define-public (set-vault-contract (vault principal))
  (begin
    (asserts! (is-eq tx-sender TOKEN-DEPLOYER) ERR-NOT-TOKEN-DEPLOYER)
    (asserts! (is-none (var-get vault-contract)) ERR-VAULT-ALREADY-SET)
    (var-set vault-contract (some vault))
    (ok true)
  )
)

(define-read-only (get-vault-contract)
  (ok (var-get vault-contract))
)

;; =============================================
;; Mint / burn -- vault only (contract-caller, not tx-sender: see header)
;; =============================================

(define-public (mint-for-vault (amount uint) (recipient principal))
  (begin
    (asserts! (is-eq (some contract-caller) (var-get vault-contract)) ERR-NOT-VAULT)
    (ft-mint? deepstack-vault-shares amount recipient)
  )
)

(define-public (burn-for-vault (amount uint) (owner principal))
  (begin
    (asserts! (is-eq (some contract-caller) (var-get vault-contract)) ERR-NOT-VAULT)
    (ft-burn? deepstack-vault-shares amount owner)
  )
)

;; =============================================
;; SIP-010 standard interface
;; =============================================

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-TOKEN-OWNER)
    (try! (ft-transfer? deepstack-vault-shares amount sender recipient))
    (match memo to-print (print to-print) 0x)
    (ok true)
  )
)

(define-read-only (get-name)
  (ok TOKEN-NAME)
)

(define-read-only (get-symbol)
  (ok TOKEN-SYMBOL)
)

(define-read-only (get-decimals)
  (ok TOKEN-DECIMALS)
)

(define-read-only (get-balance (who principal))
  (ok (ft-get-balance deepstack-vault-shares who))
)

(define-read-only (get-total-supply)
  (ok (ft-get-supply deepstack-vault-shares))
)

(define-read-only (get-token-uri)
  (ok none)
)
