// Reads a Bitflow XYK pool's on-chain reserves and derives the AMM mid price.
//
// The constant-product spot price is the most robust mid we can get: it comes
// straight from on-chain reserves, so it works even for pools whose ticker
// last_price is 0 (no recent trades). This mid is what the MM core quotes around.

import { callNoArgReadOnly, getDecimals } from "./stacks.js";

export interface PoolState {
  poolSymbol: string;
  xToken: string;
  yToken: string;
  xDecimals: number;
  yDecimals: number;
  xReserve: number; // human units
  yReserve: number; // human units
  feeBps: number; // total swap fee (provider + protocol), in basis points
  midXinY: number; // price of 1 X in Y, from constant-product reserves
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
  const feeBps =
    Number(field("x-provider-fee") ?? 0) + Number(field("x-protocol-fee") ?? 0);

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
    feeBps,
    midXinY: yReserve / xReserve, // constant-product spot price
  };
}
