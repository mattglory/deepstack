// Wallet post-conditions for every autonomous transaction (C3 / DSA-09).
//
// Before C3 each call capped only the asset it SENT, in Allow mode, so every other asset in the
// agent wallet (sBTC, USDCx, LP tokens, DLMM pool shares, STX when not the input) was protected
// only by trusting the called contracts. walletOutflowConditions() returns the input caps the
// caller passes PLUS "sender sends ≤ 0" for every other asset in WALLET_ASSETS, so a call can move
// out of the wallet exactly the assets it is meant to, up to their caps, and nothing else.
//
// WALLET_ASSETS is every fungible asset the agent wallet holds or has held
// (/extended/v1/address/SP23PF43…/balances, 2026-11-03) plus every token of the configured XYK
// pairs and DLMM pools. Asset names verified against /v2/contracts/interface on mainnet
// 2026-11-03. The tx fee is not an asset movement, so the STX ≤ 0 guard does not touch it.
//
// What the guards cannot cover: NFTs in Allow mode (a post-condition names one NFT id, not a
// class). The only NFTs this wallet holds are the DLMM pool-token-id tags, which carry no value:
// the pool burns and re-mints the wallet's tag on every mint/burn of shares (tag-pool-token-id);
// the shares themselves are the pool-token FT, which IS guarded. Calls that run in Deny mode
// (the XYK calls and DLMM swaps) forbid every unlisted movement, NFTs included.
//
// Observed outflows of real agent transactions, per call type: src/m1/fixtures/agent-asset-flows.json.

import { Pc, type PostCondition } from "@stacks/transactions";
import { PAIRS, contractId } from "./contracts.js";
import { DLMM_POOLS } from "./dlmm-read.js";

/** "STX" for native STX, otherwise the SIP-010 asset as "ADDR.contract::asset-name". */
export type AssetKey = string;

export const STX: AssetKey = "STX";
const DLMM_DEPLOYER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";

/** A DLMM pool's contract principal (the one that pays out swaps and withdrawals). */
export const dlmmPoolPrincipal = (poolName: string): string => `${DLMM_DEPLOYER}.${poolName}`;
/** A DLMM pool's share token (the pool-token FT every DLMM pool contract defines). */
export const dlmmShareKey = (poolName: string): AssetKey => `${dlmmPoolPrincipal(poolName)}::pool-token`;

const uniq = (keys: AssetKey[]) => [...new Set(keys)];

export const WALLET_ASSETS: readonly AssetKey[] = uniq([
  STX,
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token-locked",
  "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx::usdcx-token",
  "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token::ststx",
  "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc::aeUSDC",
  "SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60.deepstack-vault-token::deepstack-vault-shares",
  ...Object.values(PAIRS).flatMap((p) => [
    `${contractId(p.lp)}::${p.lp.asset}`,
    ...[p.x, p.y].map((t) => (t.native ? STX : `${t.address}.${t.name}::${t.asset}`)),
  ]),
  ...DLMM_POOLS.map((p) => dlmmShareKey(p.name)),
]);

function condition(principal: string, cmp: "lte" | "gte", amount: bigint, key: AssetKey): PostCondition {
  const p = Pc.principal(principal);
  const b = cmp === "lte" ? p.willSendLte(amount) : p.willSendGte(amount);
  if (key === STX) return b.ustx();
  const [contract, asset] = key.split("::");
  if (!asset) throw new Error(`asset key "${key}" is not ADDR.contract::asset`);
  return b.ft(contract as `${string}.${string}`, asset);
}

export interface Outflow {
  key: AssetKey;
  max: bigint; // the sender sends AT MOST this much (0 = nothing)
}

/**
 * The sender's complete outflow set: each allowed outflow capped at its max, then "sends ≤ 0" for
 * every other WALLET_ASSETS entry. Post-conditions on the same asset are ANDed, so an asset is
 * never both capped and zero-guarded. A negative max is clamped to 0. Pure.
 */
export function walletOutflowConditions(sender: string, allowed: Outflow[]): PostCondition[] {
  const seen = new Set<AssetKey>();
  for (const o of allowed) {
    if (seen.has(o.key)) throw new Error(`duplicate allowed outflow for ${o.key}`);
    seen.add(o.key);
  }
  return [
    ...allowed.map((o) => condition(sender, "lte", o.max > 0n ? o.max : 0n, o.key)),
    ...WALLET_ASSETS.filter((k) => !seen.has(k)).map((k) => condition(sender, "lte", 0n, k)),
  ];
}

/**
 * "principal sends ≥ min of asset": for Deny mode, where the pool's own payout to the wallet must
 * be covered by a condition (an uncovered pool payout is exactly what aborted 0x95b112e1, whose
 * condition named xyk-core instead of the pool). min mirrors the contract's own min-out check.
 */
export function principalSendsGte(principal: string, key: AssetKey, min: bigint): PostCondition {
  return condition(principal, "gte", min > 0n ? min : 0n, key);
}
