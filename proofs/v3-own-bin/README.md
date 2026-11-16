# Vault v3 step 1: a contract owns a Bitflow HODLMM position

Proof for [docs/VAULT_V3_DESIGN_NOTE.md](../../docs/VAULT_V3_DESIGN_NOTE.md) section 8, step 1.
Not a vault and never deployed: `contracts/own-bin-proof.clar` only adds liquidity to one bin
as itself and withdraws it, with every move of its own assets bounded by Clarity 4
`as-contract?` allowances.

It runs in simnet **against mainnet state** (`[repl.remote_data]` in `Clarinet.toml`, fixed
height), so it uses Bitflow's deployed contracts and the pool's real liquidity, not local copies.
It needs network access, so it is not part of CI.

```
npm install
HIRO_API_KEY=... npx vitest run --silent=false
```

## Result (2026-11-05, height 9,419,800, epoch 4.0, active bin 148)

| Test | Result |
|---|---|
| Reads live pool state | Active bin 148, bin step 10 |
| Contract adds 0.0001 sBTC + 8 USDCx to the active bin as itself | Pool mints 14,657,918 shares **to the contract**; the caller holds none |
| Contract withdraws them back to itself | Gets 9,723 sats + 8.211347 USDCx (same value at the bin's price, less a few cents of entry fee); shares back to 0 |
| A stranger calls withdraw | Refused (`u100`) |

## What it taught us (each failure, in order)

1. **The pool only mints to principals of the current network** (`is-standard` in `pool-mint`,
   err `u3003`). A mainnet contract principal passes; simnet's own testnet accounts do not, so
   the proof is deployed under a mainnet address.
2. **Withdrawals need `min-x + min-y > 0`** (core err `u1002`), as the agent already does.
3. **A contract's withdraw needs allowances for its pool shares too.** Withdrawing burns the
   contract's `pool-token` and re-tags its `pool-token-id` holder NFT for the bin; without
   `with-ft` and `with-nft` allowances for exactly those, `as-contract?` aborted the whole call
   (`u128`). So v3's calls can be bounded to exactly: the two tokens going in on an add, and the
   shares and holder tag going out on a withdraw. Nothing else of the vault's can move.

Not yet measured: the runtime cost of a many-bin add and withdraw (design note decision 3).
