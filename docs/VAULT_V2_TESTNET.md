# Vault v2 on testnet

Testnet dry run of `deepstack-vault-v2` (design: `docs/VAULT_V2_DESIGN.md`, reviewed D1-D14).
Test keys only, held in the gitignored `.env.testnet`. Driven with `npm run m1:vault-v2 -- <cmd> --testnet`.

## Deployment (2026-10-12)

| Contract | Testnet id | Tx |
|---|---|---|
| SIP-010 trait copy (testnet only) | ST2ZBFNYZASTNQHSQSDV2NC04Y0513GVV5SHK3W5A.sip-010-trait-ft-standard-v-1-1 | 2f8a46fc… |
| Share token (dsSTX2) | ST2ZBFNYZASTNQHSQSDV2NC04Y0513GVV5SHK3W5A.deepstack-vault-v2-token | 020177e9… |
| Vault | ST2ZBFNYZASTNQHSQSDV2NC04Y0513GVV5SHK3W5A.deepstack-vault-v2 | 31fa1b53… |
| Token linked to vault | | 3cdcf3c3… |

The mainnet SIP-010 trait the token implements does not exist on testnet, so a verbatim copy
(`contracts/testnet/`) is deployed first and the token's `impl-trait` line is pointed at it at
deploy time. The committed mainnet sources are unchanged. An earlier token deploy without it
aborted with "use of undeclared trait".

Roles: admin, guardian and fee recipient are the testnet operator
(ST2ZBFNY…K3W5A); strategy is a separate key (ST1M6DDC…T85FB). On mainnet the admin is the
2-of-3 multisig and the strategy a dedicated wallet.

## Results

| Step | Outcome |
|---|---|
| Deposit 100 STX while idle | 100 dsSTX2 minted |
| Epoch 0: sweep 50, return 55 (+5) | 10% fee: 0.478 dsSTX2 minted, worth exactly 0.50 STX; price 1.045 |
| Epoch 1: sweep 50, queue a 20 STX deposit and a 10-share withdrawal, return 47 (-3) | No fee (below the high-water price). Queued withdrawal paid 10.151428 STX and queued deposit got 19.70166 shares, both at the post-loss price 1.01514. Ring-fenced back to 0 after the claims. |
| Idle withdrawal request #0 (5 shares) | Accepted; claimable after 288 burn blocks (testnet burn blocks ~255 s, so ~20 h) |

| Deposit site, operator key (2026-10-12) | The site's own transaction code, signed with the operator test key, ran every normal path in deny mode with exact post-conditions: idle deposit 2 STX, idle request #1, epoch 2 queued deposit and withdrawal, both cancels, then settled claims of 2.928076 shares and 4.098253 STX |
| Deposit site, browser wallet (2026-10-12) | A separate testnet account (ST23PF43…DK647) used the site in a browser wallet. Correction (review, 2026-10-27): it is not independent of the operator side, because it shares its key with the mainnet agent wallet SP23PF43…WK60; the deny-mode result stands, and future site testing uses a fresh key. It deposit 5 STX for 4.880127 dsSTX2 (`82571979…`), queued all of it in epoch 3 (`0653b993…`), operator returned 21 on 20 deployed, then **claimed 5.044381 STX through the site** (`4f3b69da…`). Deny mode, one post-condition: the vault contract sends exactly 5,044,381 uSTX. |

The last row closes review finding M2 (a UI claim must succeed in deny mode).

| Idle claim of request #0 (2026-10-14) | After the 288-block delay the vault paid exactly 5.075714 STX (`35f9deff…`) |
| Epoch 4 (2026-10-12) | Swept 20 and returned 20 unchanged, an operator sequencing slip (swept before the user's deposit had landed). No P&L, no effect on holders |
| Epoch 5: overdue write-off through the site (2026-10-14) | Swept 20 and deliberately not returned. The browser-wallet account had queued a 2 STX deposit and all 4.837191 of its shares. After 432 burn blocks it pressed **Settle overdue epoch** on the site (`d51105f6…`, deny mode, zero post-conditions: no asset moves). Deposits paused automatically (D12); price fell to 0.851700. Claim refund paid exactly 2 STX 1:1 (`f0905bbb…`); claim shares back returned exactly 4.837191 dsSTX2 unpriced (`438e7c35…`, D14) |
| Drawdown block | A sweep of 5 at price 0.8517 (below 90% of the 1.045 reference) aborted with u313 (`21cde541…`) |
| Late recovery | Strategy recovered 20 STX (`recover-from-strategy`); price back to 1.033658, so the holder whose shares were returned unpriced kept full value. `queue-resume-sweeps` accepted, executable at burn block 28,307 |

| Timelocked resume (2026-10-17) | After block 28,307 `confirm-resume-sweeps` succeeded (`5d8c4f59…`): the sweep reference reset to the current price 1.033658 and the fee high-water mark stayed at 1.045 (D13). Deposits unpaused by the admin (`7c145e7a…`) |

## 2-of-3 multisig admin (2026-10-15)

The design requires the admin flow to be proven with the real 2-of-3 setup on testnet before
any mainnet deploy (section 9). Tooling: `src/m1/vault-v2-multisig-cli.ts`
(`npm run m1:vault-v2-ms`). It splits every admin call into **build** (no key), **sign**
(one key, one machine, writes one signature file) and **broadcast** (assembles the signatures
in the fixed key order). It uses non-sequential multisig, so signers sign independently and in
any order. Here three test keys stand in for the three devices.

A second rehearsal vault was deployed from a separate test deployer and initialized with the
multisig as admin, mirroring how mainnet will be set up.

| Item | Value |
|---|---|
| Multisig admin (2-of-3) | SN1X3JWJQMYSQGM864E70Y9SQFKEHXYT90VXM4JQD |
| Rehearsal vault | ST3AH6PKM896NMXRP4VA8RW5C2EMFQB5QHT54KXVS.deepstack-vault-v2 |
| Guardian and fee recipient | ST3AH6PK…XVS (single key, pause-only as guardian) |
| Strategy | ST1M6DDC…T85FB (same test strategy key) |

| Step | Outcome |
|---|---|
| `initialize` with the multisig as admin | Success; `get-state` shows the multisig as admin |
| A single key (the deployer) calls `sweep` | Rejected on-chain, u300 not-admin |
| Multisig `sweep 20`, signed by key 3 alone | Refused before broadcast: 1 of 2 required signatures |
| The same transaction, then signed by key 1 (out of order) | Broadcast 2-of-3, success (`da8de776…`) |
| Strategy returns 21 | Epoch settled |
| Multisig `pause-deposits` (keys 2+3), `unpause-deposits` (keys 1+3) | Both success |
| Guardian single key `pause-sweeps` | Success (the guardian can pause) |
| Guardian single key `unpause-sweeps` | Rejected, u300 (only the admin can unpause) |
| Multisig `unpause-sweeps` (keys 1+2) | Success |
| Multisig `queue-fee-bps 1500` (keys 2+1) | Queued, executable at burn block 28,631 |

Also queued on the first testnet vault: `queue-admin-change` to the same multisig
(executable at burn block 28,631), so the hand-over path (`accept-admin-change`, which only
the proposed admin can call) is proven by the multisig itself.

| After block 28,631 (2026-10-19): `confirm-fee-bps` signed by keys 3+2 | Success; the rehearsal vault's fee is now 15% |
| `accept-admin-change` on the first vault, signed by the multisig (keys 1+3) | Success; the first vault's admin is now the multisig |
| The old single operator key then queues a fee change on the first vault | Rejected on-chain, u300 not-admin |

Before mainnet: the same flow with the real devices (two hardware wallets and the offline
recovery key).

## Multisig tool hardening (2026-10-27, after review)

The review of #18 found that `sign` signed whatever file it was given. Now:

| Change | Testnet evidence |
|---|---|
| Only allow-listed vault admin functions on the configured vault (`MS_VAULT`) can be built or signed | `deposit` and a call to a different vault were refused before anything was built |
| `sign` decodes and prints network, contract, function, arguments, nonce, fee and post-condition mode, and needs the function name typed back | A wrong word cancelled with nothing signed; the right word signed |
| Deny mode for every admin call; `sweep` asserts the vault sends exactly the amount | `pause-deposits` (`de9c0fe6…`) and `unpause-deposits` with 0 post-conditions; `sweep 5 STX` with 1 post-condition; all succeeded |
| Each signature records the pre-sign hash; `broadcast` ignores signatures made for another transaction | A signature copied from another transaction was ignored, and broadcast refused with too few signatures |

Still before mainnet (a hard gate): the same flow with the real devices. The tool signs only
with raw keys from the environment; hardware-wallet signing, and whether those wallets can sign
a SIP-027 non-sequential multisig, are not yet proven.
