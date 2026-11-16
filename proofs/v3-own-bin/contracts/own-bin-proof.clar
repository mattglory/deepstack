;; v3 step 1 proof (design note section 8): can a contract own a Bitflow HODLMM position?
;; The contract adds liquidity to one bin as itself and withdraws it, and every move of its own
;; tokens is bounded by as-contract? allowances. Not a vault: no shares, no access control beyond
;; an owner, never deployed to mainnet.

(define-constant OWNER tx-sender)
(define-constant ERR-NOT-OWNER (err u100))

(define-public (fund (sbtc uint) (usdcx uint))
  (begin
    (if (> sbtc u0) (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer sbtc tx-sender current-contract none)) true)
    (if (> usdcx u0) (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx transfer usdcx tx-sender current-contract none)) true)
    (ok true)))

(define-public (add-one (bin-id int) (x uint) (y uint) (min-dlp uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR-NOT-OWNER)
    (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" x)
                   (with-ft 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx "usdcx-token" y))
      (try! (contract-call? 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-2 add-liquidity-multi
        (list {
          pool-trait: 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10,
          x-token-trait: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token,
          y-token-trait: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx,
          bin-id: bin-id, x-amount: x, y-amount: y, min-dlp: min-dlp,
          max-x-liquidity-fee: x, max-y-liquidity-fee: y })
        none)))))

(define-public (withdraw-one (bin-id int) (amount uint) (min-x uint) (min-y uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR-NOT-OWNER)
    ;; Withdrawing burns the contract's own pool shares and re-tags its holder NFT for the bin;
    ;; both are moves of its own assets, so both need allowances (without them, as-contract?
    ;; aborted the call with err u128).
    (as-contract? ((with-ft 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10 "pool-token" amount)
                   (with-nft 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10 "pool-token-id"
                     (list { token-id: (to-uint (+ bin-id 500)), owner: current-contract })))
      (try! (contract-call? 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-2 withdraw-liquidity-multi
        (list {
          pool-trait: 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10,
          x-token-trait: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token,
          y-token-trait: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx,
          bin-id: bin-id, amount: amount, min-x-amount: min-x, min-y-amount: min-y })
        none)))))
