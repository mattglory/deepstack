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

Still to run on testnet: the idle claim after the delay, the drawdown block and timelocked
resume, an overdue write-off with a late recovery, and a claim through the deposit site in
deny mode (closes review finding M2).
