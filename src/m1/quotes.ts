// Read-only quotes used to set slippage guards (min-*) for write transactions.
// Never submit a write with min = 0 — always size guards from a fresh quote.

import { fetchCallReadOnlyFunction, Cl, cvToJSON } from "@stacks/transactions";
import { config } from "../config.js";
import { CORE, activePool } from "./contracts.js";
import { withRpc, hiroFetch } from "./rpc.js";

const poolTraitArgs = () => {
  const p = activePool();
  return [
    Cl.contractPrincipal(p.pool.address, p.pool.name),
    Cl.contractPrincipal(p.x.address, p.x.name),
    Cl.contractPrincipal(p.y.address, p.y.name),
  ];
};

async function callCore(functionName: string, extraArgs: ReturnType<typeof Cl.uint>[]) {
  const cv = await withRpc((baseUrl) =>
    fetchCallReadOnlyFunction({
      contractAddress: CORE.address,
      contractName: CORE.name,
      functionName,
      functionArgs: [...poolTraitArgs(), ...extraArgs],
      network: "mainnet",
      client: { baseUrl, fetch: hiroFetch(baseUrl) },
      senderAddress: config.senderAddress,
    }),
  );
  return cvToJSON(cv) as any;
}

export interface AddLiquidityQuote {
  dlp: bigint; // LP tokens minted for adding xAmount of sBTC
  yAmount: bigint; // paired STX (microSTX) the pool will pull
}

// get-dlp(pool, x, y, x-amount) -> (tuple (dlp uint) (y-amount uint))
export async function getAddLiquidityQuote(xAmount: bigint): Promise<AddLiquidityQuote> {
  const j = await callCore("get-dlp", [Cl.uint(xAmount)]);
  const t = j?.value?.value;
  if (!t) throw new Error("get-dlp returned no tuple");
  return { dlp: BigInt(t.dlp.value), yAmount: BigInt(t["y-amount"].value) };
}

// get-dy(pool, x, y, x-amount) -> y out for swapping xAmount of sBTC in
export async function getSwapXForYQuote(xAmount: bigint): Promise<bigint> {
  const j = await callCore("get-dy", [Cl.uint(xAmount)]);
  return BigInt(j.value.value);
}

// get-dx(pool, x, y, y-amount) -> x out for swapping yAmount of STX in
export async function getSwapYForXQuote(yAmount: bigint): Promise<bigint> {
  const j = await callCore("get-dx", [Cl.uint(yAmount)]);
  return BigInt(j.value.value);
}

// Raw pool reserves + total shares (base units), read from the pool's get-pool.
export async function getPoolRaw(): Promise<{
  xBalance: bigint;
  yBalance: bigint;
  totalShares: bigint;
}> {
  const p = activePool();
  const cv = await withRpc((baseUrl) =>
    fetchCallReadOnlyFunction({
      contractAddress: p.pool.address,
      contractName: p.pool.name,
      functionName: "get-pool",
      functionArgs: [],
      network: "mainnet",
      client: { baseUrl, fetch: hiroFetch(baseUrl) },
      senderAddress: config.senderAddress,
    }),
  );
  const t = (cvToJSON(cv) as any)?.value?.value;
  if (!t) throw new Error("get-pool returned no tuple");
  return {
    xBalance: BigInt(t["x-balance"].value),
    yBalance: BigInt(t["y-balance"].value),
    totalShares: BigInt(t["total-shares"].value),
  };
}

// Proportional withdrawal: burning lpAmount returns its share of both reserves.
// No dedicated core helper exists, so compute from on-chain reserves + shares.
export async function getWithdrawQuote(
  lpAmount: bigint,
): Promise<{ xOut: bigint; yOut: bigint }> {
  const { xBalance, yBalance, totalShares } = await getPoolRaw();
  if (totalShares === 0n) throw new Error("pool has no shares");
  return {
    xOut: (lpAmount * xBalance) / totalShares,
    yOut: (lpAmount * yBalance) / totalShares,
  };
}

// slippage helpers (bps): floor for outputs we receive, ceiling for inputs we send
export const minusSlippage = (amount: bigint, bps: number): bigint =>
  (amount * BigInt(10_000 - bps)) / 10_000n;
export const plusSlippage = (amount: bigint, bps: number): bigint =>
  (amount * BigInt(10_000 + bps)) / 10_000n;

// Reference floor for an XYK swap's min-out (C5 / DSA-11). The quote above comes from the same
// RPC/pool it guards, so a deflated quote (lying RPC, or a pool pushed just before the read) used
// to lower the min-out with it. The floor is the output implied by the external reference
// (safety.ts getExternalMid: two sources, fresh, agreeing) less a tolerance, and the min-out
// sent is the larger of the two: it can only get stricter.
//
// Tolerance = XYK_REF_MIN_OUT_BAND_BPS (default 500, the safety gate's pool-vs-reference band,
// defaultSafetyParams().maxDivergenceBps) + the trade's own slippage. A trade only reaches this
// point after the safety gate accepted a pool mid within that band of the reference, so its fill
// is at worst ~ref x (1 - band) x (1 - fee) x (1 - impact): with the 30 bps pool fee and capped
// trade sizes that stays above ref x (1 - band - slippage), and a normal trade's min-out is
// still the quote-based one. A slippage-only tolerance (100 bps) would abort ordinary trades
// whenever the pool sat ~0.7% on the wrong side of the reference.
export function refBandBps(): number {
  const raw = process.env.XYK_REF_MIN_OUT_BAND_BPS;
  if (raw === undefined || raw.trim() === "") return 500;
  const n = Number(raw);
  if (!(n >= 0 && n < 10_000)) throw new Error(`XYK_REF_MIN_OUT_BAND_BPS must be 0-9999 (got '${raw}')`);
  return n;
}

/**
 * max(quoteMin, reference-implied output less band + slippage), in the output token's base
 * units. refMidXinY is y per x in human units (ExternalMid.midXinY). Pure apart from the env.
 */
export function floorMinOutByReference(
  quoteMin: bigint,
  direction: "x-for-y" | "y-for-x",
  amountIn: bigint,
  refMidXinY: number,
  xDecimals: number,
  yDecimals: number,
  slippageBps: number,
): bigint {
  if (!(refMidXinY > 0)) throw new Error("reference floor: no usable reference mid");
  const keep = 1 - (refBandBps() + slippageBps) / 10_000;
  if (!(keep > 0)) return quoteMin;
  const refOut =
    direction === "x-for-y"
      ? (Number(amountIn) / 10 ** xDecimals) * refMidXinY * 10 ** yDecimals
      : (Number(amountIn) / 10 ** yDecimals / refMidXinY) * 10 ** xDecimals;
  const refMin = BigInt(Math.floor(refOut * keep));
  return refMin > quoteMin ? refMin : quoteMin;
}
