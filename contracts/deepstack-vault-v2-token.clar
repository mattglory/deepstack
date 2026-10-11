;; deepstack-vault-v2-token -- vault shares for deepstack-vault-v2 (dsSTX2).
;;
;; STATUS: NOT DEPLOYED. Built test-first against docs/VAULT_V2_DESIGN.md (approved by the
;; independent reviewer 2026-10-11). Testnet first, then a re-review, before any mainnet deploy.
;;
;; Same shape as v1's token, which the review found sound: mint and burn are reachable only
;; through the linked vault (contract-caller gate), and the vault is linked exactly once by the
;; deployer. Differences from v1: a distinct name and symbol, and 9 decimals instead of 6 so the
;; vault can use a 1 asset : 10^3 shares virtual offset (design note section 8, review L4).

(impl-trait 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.sip-010-trait-ft-standard-v-1-1.sip-010-trait)

(define-fungible-token deepstack-vault-v2-shares)

(define-constant TOKEN-DEPLOYER tx-sender)
(define-constant TOKEN-NAME "DeepStack Vault Shares v2")
(define-constant TOKEN-SYMBOL "dsSTX2")
(define-constant TOKEN-DECIMALS u9)

(define-constant ERR-NOT-TOKEN-DEPLOYER (err u200))
(define-constant ERR-VAULT-ALREADY-SET  (err u201))
(define-constant ERR-NOT-VAULT          (err u202))
(define-constant ERR-NOT-TOKEN-OWNER    (err u203))

(define-data-var vault-contract (optional principal) none)

;; One-time link to the vault. No path changes it afterwards.
(define-public (set-vault-contract (vault principal))
  (begin
    (asserts! (is-eq tx-sender TOKEN-DEPLOYER) ERR-NOT-TOKEN-DEPLOYER)
    (asserts! (is-none (var-get vault-contract)) ERR-VAULT-ALREADY-SET)
    (var-set vault-contract (some vault))
    (print { event: "vault-linked", vault: vault })
    (ok true)
  )
)

(define-read-only (get-vault-contract) (ok (var-get vault-contract)))

(define-public (mint-for-vault (amount uint) (recipient principal))
  (begin
    (asserts! (is-eq (some contract-caller) (var-get vault-contract)) ERR-NOT-VAULT)
    (ft-mint? deepstack-vault-v2-shares amount recipient)
  )
)

(define-public (burn-for-vault (amount uint) (owner principal))
  (begin
    (asserts! (is-eq (some contract-caller) (var-get vault-contract)) ERR-NOT-VAULT)
    (ft-burn? deepstack-vault-v2-shares amount owner)
  )
)

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-TOKEN-OWNER)
    (try! (ft-transfer? deepstack-vault-v2-shares amount sender recipient))
    (match memo to-print (print to-print) 0x)
    (ok true)
  )
)

(define-read-only (get-name) (ok TOKEN-NAME))
(define-read-only (get-symbol) (ok TOKEN-SYMBOL))
(define-read-only (get-decimals) (ok TOKEN-DECIMALS))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance deepstack-vault-v2-shares who)))
(define-read-only (get-total-supply) (ok (ft-get-supply deepstack-vault-v2-shares)))
(define-read-only (get-token-uri) (ok none))
