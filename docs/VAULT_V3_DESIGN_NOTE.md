# Vault v3: the vault owns the position (design note, draft)

Status: DRAFT for discussion, 2026-10-19; research update 2026-11-05 (sections 2, 6 and 9).
Nothing here is built. v3 is the step required before any outside deposit. Proposed
2026-11-05, pending the founders' decision: v2 stays a testnet reference and is not deployed
to mainnet (section 8).

## 1. Why v3

In v2 the admin sweeps up to 50% of assets to a strategy wallet, which runs the strategy and
returns STX at the end of an epoch. The contract bounds the damage (deploy cap, 432-block
epoch deadline, write-off, drawdown block) but cannot force the return. That is custodial in
practice, which the independent review called out and which v2's own disclosure states.

Steer-style vaults work the other way round: the deposits never leave the vault contract. The
operator can only tell the vault to move its liquidity, and the contract checks every
instruction. v3 adopts that model for one Bitflow HODLMM pool.

## 2. Verified feasibility

Checked against the live mainnet contract sources (read from the Hiro API) on 2026-10-19:

- `SP1PFR4V…dlmm-core-v-1-1` `add-liquidity` takes `caller` as `tx-sender`, transfers the
  x and y tokens from `caller` to the pool, and mints the bin's LP shares to `caller`.
  `withdraw-liquidity` sends the tokens back to `caller` and burns `caller`'s shares. There is
  no check that `caller` is a standard principal.
- So a vault contract that calls the core (directly, or through
  `SM1FKXG…dlmm-liquidity-router-v-1-2`) from its own context becomes the owner of the bins.
  Only it can withdraw them.
- `withdraw-liquidity` only checks that the pool is a known pool, not that it is enabled,
  so withdrawals keep working if Bitflow disables a pool. `add-liquidity` and the swaps
  require an enabled pool.
- The core's admins control its verified-pool list, pool status and fees, and can **migrate a
  pool to a new core** after a cooldown (default two weeks, minimum one week, enforced in the
  core). After a migration the old core rejects withdrawals for that pool, so v3 must not
  hard-code the core address: it has to follow the pool's current core, with the vault's own
  timelock shorter than Bitflow's minimum migration cooldown. These are third-party
  dependencies v3 inherits (section 7).

**Clarity version (checked 2026-11-05).** Clarity 4 replaced `as-contract` with `as-contract?`,
which takes explicit asset allowances (`with-ft`, `with-stx`) and aborts the call if the
contract's own assets move beyond them. Mainnet runs Clarity 6 since the PoX-5 upgrade, and
the repo's simulator (clarinet-sdk 3.24) supports Clarity 4 to 6. v3 should use it: every call
the vault makes as itself allows only the fixed sBTC and USDCx amounts for that step, so the
language, not only our own checks, stops the vault's assets going anywhere else. Confirm the
exact allowance syntax and Clarity version at build time.

Not yet verified: the runtime cost of a multi-bin add and withdraw from inside another
contract (step 1 of section 8 measures it).

## 3. Shape

- **One pool per vault:** sBTC/USDCx (`dlmm-pool-sbtc-usdcx-v-1-bps-10`). The pool and both
  token contracts are fixed at deploy time.
- **Two-asset deposits, in kind.** A depositor adds sBTC and USDCx in the vault's current
  ratio of the two tokens and receives shares pro rata. Withdrawals are pro rata in kind: the
  depositor's share of the idle balances plus their share of every bin, withdrawn by the
  contract. This needs no price at all, which removes the main manipulation risk of pricing
  shares from a pool that can be moved within a block.
- **Withdrawals are never blocked by the operator.** No epoch is needed. The position is
  always in the contract, so a holder can always take their share. Pause stops deposits and
  rebalances, never withdrawals.
- **Fee:** a management fee minted as shares over time (for example a few percent a year),
  because a performance fee needs a valuation and therefore a price. A performance fee can
  come later, if a manipulation-resistant price source is available on Stacks.

## 4. The operator's only power: `rebalance`

The keeper (the DeepStack agent) can call one function: withdraw some or all bins, then add
liquidity over a new range. The contract enforces:

| Check | Purpose |
|---|---|
| Pool and tokens are the fixed ones | Funds can only go into this pool |
| New range is centred within a few bins of the active bin, half-width between set bounds | No deliberately out-of-range or absurd positions |
| Per-bin minimum shares on add and minimum amounts on withdraw | Slippage limits |
| Cooldown between rebalances and a cap per day | Limits loss from rebalancing too often, deliberately or by a bug |
| Active-bin price within a set distance of an external reference, if one is available on chain | Refuses to rebalance into a manipulated price |
| Nothing leaves to any address except the pool or a withdrawing holder | The operator cannot take funds |

The worst a compromised keeper can then do is rebalance badly within those limits. That is a
bounded cost, not a loss of principal. The guardian can pause rebalances at once.

## 5. Roles

As in v2: a 2-of-3 native multisig admin (now proven on testnet), a pause-only guardian and a
keeper. Changing the keeper, the bounds or the fee goes through the same timelock. There is
no admin path that moves user funds.

## 6. Hard problems to solve before building

1. **First depositor and donation attacks** on in-kind share pricing. The v2 virtual-offset
   approach likely carries over, but it must be adapted for two assets.
2. **Bin dust and rounding** when a holder withdraws a share of many bins. Make sure the
   rounding is always against the withdrawer and that no bin can be stranded.
3. **Runtime cost:** the maximum number of bins a single withdraw can touch inside one
   transaction bounds the maximum range width.
4. **Reference price:** see section 9. Two on-chain sources exist; the proposal is to require
   both to agree before any rebalance.
5. **The pool's own risks:** Bitflow can change verified pools and fees, disable pools and
   migrate them to a new core (section 2). Bitflow runs an Immunefi bug bounty that refers to
   completed audits, but no published audit report for the DLMM core was found on
   2026-10-19 or again on 2026-11-05 (only community reviews of the swap router). The audit
   status must be confirmed with Bitflow and disclosed.
6. **Testing venue:** HODLMM does not appear to exist on testnet, so testing has to use
   simnet with the mainnet contract sources, then a tiny mainnet proof.

## 7. Dependencies and disclosure

v3 trusts the Bitflow DLMM core and pool contracts and their admin. The disclosure must say
so plainly, alongside the professional audit status of v3 itself.

## 8. Plan

1. Prove the core pattern in simnet against the mainnet Bitflow sources (a minimal contract
   that adds and withdraws one bin as itself).
2. A tiny mainnet proof with the owner's own funds: the contract adds, rebalances and
   withdraws.
3. Full design review (the original reviewer is now a co-founder, so an outside reviewer as
   well), then test-first Clarity, as for v2.
4. Professional audit before any outside deposit.

**v2 (proposed 2026-11-05, pending the founders' decision):** v2 is fully exercised on testnet
(docs/VAULT_V2_TESTNET.md) but custodial in practice, which v3 removes. Deploying it to mainnet
with the owner's own capital would add little evidence beyond the live agent and would split
effort. Proposal: keep v2 as the tested reference and carry its parts into v3 (share accounting
with a virtual offset, the high-water-mark fee logic if a price is available, the 2-of-3
multisig admin, timelocks, the pause-only guardian). The open v2 fixes from the 2026-11
assessment (#59, #60) are merged for the record or closed, rather than deployed.

## 9. Reference price on Stacks (measured 2026-11-05)

| Source | What it is | Measured | Trust |
|---|---|---|---|
| DIA (`SP1G48FZ…dia-oracle`, `get-value`) | Push oracle: an updater writes prices on chain | BTC/USD updated 7 minutes before the read, within 0.1% of CoinGecko. Its sBTC/USD key read about 5% above BTC/USD, so it is not used | One updater key (`get-oracle-updater`) |
| Pyth (`SP3R4F6C…pyth-oracle-v3`, `pyth-storage-v3`) | Pull oracle: a caller submits a price update signed by Pyth, verified on chain | Stored BTC/USD was about 8 months old: nobody keeps it fresh. A rebalance would carry its own fresh signed update | Pyth's signer set; the keeper fetches the update but cannot forge it |

**Proposal:** a rebalance must (a) include a fresh Pyth BTC/USD update verified in the same
transaction, (b) read DIA BTC/USD no older than a set limit, (c) find the two within a set
distance of each other, and (d) find the pool's active-bin price within a set distance of them.
If any part fails, the rebalance is refused. Withdrawals never depend on a price.

Assumptions to state in the disclosure: sBTC is valued as BTC and USDCx as USD (both pegs),
and the oracle operators are trusted for the rebalance check only.

To measure in step 1 of section 8: the cost of verifying a Pyth update inside the rebalance
call, and whether `pyth-oracle-v3` accepts the current update format.

A reliable price also makes a performance fee over a high-water mark possible (section 3);
the founders decide between that and a management fee.

## 10. Decisions for the founders

1. Deposits: in kind, both tokens (section 3, needs no price), or single-asset with a swap.
2. Fee: management fee (no price needed) or performance fee over a high-water mark (needs
   section 9).
3. Maximum range width, which bounds the runtime cost of a withdraw.
4. Zest for idle reserve: in v3, or a later version (recommended: later, to keep the first
   audited version small).
5. v2: not deployed to mainnet (proposed in section 8).
