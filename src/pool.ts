// Reads a Bitflow XYK pool's on-chain reserves and derives the AMM mid price.
//
// The constant-product spot price is the most robust mid we can get: it comes
// straight from on-chain reserves, so it works even for pools whose ticker
// last_price is 0 (no recent trades). This mid is what the MM core quotes around.

import { callNoArgReadOnly, getDecimals } from "./stacks.js";

/**
 * Constant-product mid (Y per 1 X) computed directly from the bigint reserves.
 *
 * Bug-class-3 hardening: the naive path is `Number(base) / 10^dec` per reserve, then a ratio.
 * `Number()` silently drops integer precision above 2^53, so a reserve exceeding ~9e15 base units
 * (e.g. > ~9 billion STX in microSTX) would misprice the mid. This does the division in BigInt
 * first (exact at any reserve size) with 1e9 fixed-point, then converts the small quotient to a
 * float. At today's reserve sizes both fit in a double, so this equals the naive ratio to ~1e-9
 * and behaviour is unchanged. Returns 0 on an empty x-reserve rather than Infinity.
 */
export function midFromReserves(xBase: bigint, yBase: bigint, xDecimals: number, yDecimals: number): number {
  if (xBase <= 0n) return 0;
  const PREC = 1_000_000_000n; // 9 decimal places of fixed-point on the mid
  const num = yBase * 10n ** BigInt(xDecimals) * PREC;
  const den = xBase * 10n ** BigInt(yDecimals);
  return Number(num / den) / 1e9;
}

export interface PoolState {
  poolSymbol: string;
  xToken: string;
  yToken: string;
  xDecimals: number;
  yDecimals: number;
  xReserve: number; // human units
  yReserve: number; // human units
  providerFeeBps: number; // fee that accrues to LPs, in basis points
  protocolFeeBps: number; // fee that accrues to the protocol, in basis points
  feeBps: number; // total swap fee (provider + protocol), in basis points
  midXinY: number; // price of 1 X in Y, from constant-product reserves
  poolActive: boolean; // pool-status flag — false means the venue paused the pool
}

export async function getPoolState(principal: string): Promise<PoolState> {
  const json = (await callNoArgReadOnly(principal, "get-pool")) as any;
  const tuple = json?.value?.value;
  if (!tuple) throw new Error(`get-pool returned no tuple for ${principal}`);
  const field = (k: string): string => tuple[k]?.value;

  const xToken = field("x-token");
  const yToken = field("y-token");
  const xBalance = BigInt(field("x-balance"));
  const yBalance = BigInt(field("y-balance"));
  const providerFeeBps = Number(field("x-provider-fee") ?? 0);
  const protocolFeeBps = Number(field("x-protocol-fee") ?? 0);
  const feeBps = providerFeeBps + protocolFeeBps;

  // Token decimals come from each token contract (not in the pool tuple).
  const [xDecimals, yDecimals] = await Promise.all([
    getDecimals(xToken),
    getDecimals(yToken),
  ]);

  const xReserve = Number(xBalance) / 10 ** xDecimals;
  const yReserve = Number(yBalance) / 10 ** yDecimals;

  return {
    poolSymbol: field("pool-symbol"),
    xToken,
    yToken,
    xDecimals,
    yDecimals,
    xReserve,
    yReserve,
    providerFeeBps,
    protocolFeeBps,
    feeBps,
    midXinY: midFromReserves(xBalance, yBalance, xDecimals, yDecimals), // constant-product spot price (bigint-safe)
    poolActive: Boolean(tuple["pool-status"]?.value),
  };
}
