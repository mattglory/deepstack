# M1 Technical Plan — write-side on the Bitflow sBTC-STX pool

Verified against live mainnet contracts and `@stacks/transactions` **v7.4.0** (Jun 2026).

## 0. Reality check: this is an XYK (constant-product) pool

`xyk-pool-sbtc-stx-v-1-1` is a **full-range, constant-product** AMM (x·y=k) — **not**
a Uniswap-v3-style concentrated-liquidity pool. There is **no price range to set**.
So the agent's market-making levers here are:

1. **Liquidity provision** — `add-liquidity` / `withdraw-liquidity` (always full range).
2. **Inventory rebalancing** — `swap-x-for-y` / `swap-y-for-x` to hold a target
   sBTC/STX inventory ratio and hedge directional drift.
3. **Regime response** — size up / pull liquidity when the AI layer flags adverse
   conditions (the `mm.ts` band is used as **rebalance/hedge thresholds**, not as a
   concentrated LP range).

> True two-sided *quoting* (the part of your Dexalot edge that transfers 1:1) lives on
> **Velar perps**, not on an XYK AMM. Keep Bitflow as the LP/fee-capture + inventory leg;
> treat Velar as the quoting venue (M3 stretch / follow-on grant).

## 1. Contracts & tokens (mainnet, verified)

| Role | Principal | Decimals |
|---|---|---|
| Core (entry point) | `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2` | — |
| Pool (trait) | `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1` | — |
| x-token = sBTC | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` | 8 |
| y-token = STX (wrapped) | `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2` | 6 |

**You always call the `core` contract**, passing the pool + both tokens as trait refs.
⚠️ Confirm at build time: the SIP-010 **asset names** inside each token contract (needed
for post-conditions), and whether native STX must be wrapped into `token-stx-v-1-2` first.

## 2. Verified write functions (on `xyk-core-v-1-2`)

```
add-liquidity     (pool-trait, x-token-trait, y-token-trait, x-amount, min-dlp)
withdraw-liquidity(pool-trait, x-token-trait, y-token-trait, amount, min-x-amount, min-y-amount)
swap-x-for-y      (pool-trait, x-token-trait, y-token-trait, x-amount, min-dy)
swap-y-for-x      (pool-trait, x-token-trait, y-token-trait, y-amount, min-dx)
```

Quote helpers (call read-only to size the `min-*` slippage guards — no tx needed):
```
get-dlp(pool, x-trait, y-trait, x-amount)  -> LP tokens minted for adding x-amount
get-dy (pool, x-trait, y-trait, x-amount)  -> y out for swapping x-amount in
get-dx (pool, x-trait, y-trait, y-amount)  -> x out for swapping y-amount in
```

## 3. Signing path (`@stacks/transactions` v7.4.0)

```ts
import {
  makeContractCall, broadcastTransaction, fetchCallReadOnlyFunction,
  Cl, Pc, PostConditionMode, getAddressFromPrivateKey,
} from "@stacks/transactions";

const SLIPPAGE = 0.01; // 1% — tunable by the AI layer

// 1) quote: expected LP tokens for adding `xAmount` sBTC (base units, 8dp)
const dlpCv = await fetchCallReadOnlyFunction({
  contractAddress: CORE.address, contractName: CORE.name,
  functionName: "get-dlp",
  functionArgs: [
    Cl.contractPrincipal(POOL.address, POOL.name),
    Cl.contractPrincipal(SBTC.address, SBTC.name),
    Cl.contractPrincipal(STX.address, STX.name),
    Cl.uint(xAmount),
  ],
  network: "mainnet", senderAddress,
});
const expectedDlp = BigInt(/* parse dlpCv */);
const minDlp = (expectedDlp * BigInt(Math.floor((1 - SLIPPAGE) * 1e6))) / 1_000_000n;

// 2) build + sign add-liquidity, with strict post-conditions
const tx = await makeContractCall({
  contractAddress: CORE.address, contractName: CORE.name,
  functionName: "add-liquidity",
  functionArgs: [
    Cl.contractPrincipal(POOL.address, POOL.name),
    Cl.contractPrincipal(SBTC.address, SBTC.name),
    Cl.contractPrincipal(STX.address, STX.name),
    Cl.uint(xAmount),
    Cl.uint(minDlp),
  ],
  senderKey,                 // from a dedicated, funded key (see §6)
  network: "mainnet",
  postConditionMode: PostConditionMode.Deny,   // reject anything not asserted
  postConditions: [
    // never send more sBTC than intended
    Pc.principal(senderAddress).willSendLte(xAmount).ft(SBTC.id, SBTC.asset),
    // bound the y (STX) leg the pool pulls by ratio: expected * (1+slippage)
    Pc.principal(senderAddress).willSendLte(maxYAmount).ft(STX.id, STX.asset),
  ],
});
const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
```

`withdraw-liquidity` is the mirror image: assert you **receive at least** the floors with
`Pc.principal(sender).willSendGte(minX).ft(...)` for each leg (Deny mode).

Verified `Pc` builder chain: `Pc.principal(addr).willSendLte|willSendGte|willSendEq(amount).ft(contractId, assetName)` (or `.ustx()` for native STX).

## 4. Slippage & safety rules

- **Always** set `min-dlp` / `min-dy` / `min-dx` / `min-x` / `min-y` from a fresh
  `get-*` quote × `(1 ± SLIPPAGE)`. Never submit with `min = 0`.
- **`PostConditionMode.Deny`** on every write — the tx aborts if token movement differs
  from what we asserted. This is the on-chain backstop against a mispriced/forked pool.
- Re-quote immediately before signing; reject if the mid moved more than a guard band
  since the decision (stale-quote protection).

## 5. M1 task breakdown (~3–4 weeks with help)

1. **`src/wallet.ts`** — load key from env, derive address, nonce/fee handling.
2. **`src/quotes.ts`** — wrap `get-dlp` / `get-dy` / `get-dx` read-only calls → `min-*`.
3. **`src/actions.ts`** — `addLiquidity`, `withdrawLiquidity`, `swap` builders with
   post-conditions; `--dry-run` prints the tx + post-conditions without broadcasting.
4. **Testnet pass** — deploy/find an equivalent testnet pool, exercise add/withdraw/swap.
5. **Mainnet smoke** — one tiny real add + withdraw (dust) to confirm end-to-end.
6. **`src/agent.ts`** — loop: read reserves → AI params → decide → rebalance/LP → log.

## 6. Key management (do this right)

- Use a **dedicated mainnet key** funded with only the ~$1K pilot inventory.
- Key from env / OS keychain — **never** committed (`.env` is gitignored).
- Cap per-tx size and daily turnover in config; the AI layer tunes within those caps.

## 7. What stays out of M1

- No concentrated ranges (XYK doesn't have them).
- No Velar perps quoting (M3 stretch).
- No LLM in the hot path — the agent loop is deterministic; AI only sets params.
