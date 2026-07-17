// Divergence capture — the sizing core for FlashStack flash-rebalancing (M2).
//
// LVR measurement (lvr.ts) shows what the pool loses to arbitrageurs when its price
// diverges from the outside market. This module is the other side of that coin: given the
// pool's reserves and an external reference mid, compute the OPTIMAL trade that closes the
// divergence and what it earns after every cost. Two honest uses:
//
//   1. Toxicity-aware rebalancing (now): when the agent must rebalance anyway, prefer the
//      cycles where the pool's mispricing pays the agent to trade — internalising LVR
//      instead of donating it.
//   2. Flash-arb sizing (M2): the same optimum sizes a FlashStack flash-loan arb, where
//      the borrowed leg is repaid atomically (docs/FLASH_REBALANCE.md). Capture requires
//      a second venue in the same transaction; detection does not.
//
// The math (constant-product pool x·y = k, input fee f, external mid P in y per x):
//   buy-x  (pool underprices x): input dy → x_out = x·(1−f)·dy / (y + (1−f)·dy)
//     optimum  dy* = (√(P·x·y·(1−f)) − y) / (1−f),   profitable iff P·(1−f) > y/x
//   sell-x (pool overprices x):  input dx → y_out = y·(1−f)·dx / (x + (1−f)·dx)
//     optimum  dx* = (√(x·y·(1−f)/P) − x) / (1−f),   profitable iff (y/x)·(1−f) > P
// Both follow from setting the pool's post-trade marginal price equal to the external mid;
// beyond that point every extra unit trades at a loss.
//
// Detection only — this module never signs or broadcasts anything.

export interface ArbOpportunity {
  direction: "buy-x" | "sell-x"; // trade against the pool's mispricing
  amountIn: number; // human units of the input asset (y for buy-x, x for sell-x)
  amountOut: number; // human units received from the pool
  grossEdgeY: number; // value gained at the external mid, before costs (y units)
  flashFeeY: number; // FlashStack 5bps on the borrowed input, valued in y
  gasY: number; // network fee, valued in y
  netEdgeY: number; // what the trade actually earns
  divergenceBps: number; // |pool mid − external| / external
}

export interface ArbCosts {
  poolFeeBps: number; // total swap fee the pool charges on input (provider + protocol)
  flashFeeBps?: number; // FlashStack fee on the borrowed amount (default 5bps)
  gasY?: number; // network fee in y units (default 0)
}

export const FLASH_FEE_BPS = 5; // FlashStack's 0.05%, accrues to FlashStack LPs

/**
 * The optimal divergence-capture trade, or null when no trade nets out positive after
 * pool fee, flash fee, and gas. Null is the normal result — at 50bps pool fee the pool
 * must diverge >~0.5% from the external mid before any edge exists at all.
 */
export function findArb(
  xReserve: number,
  yReserve: number,
  externalMid: number,
  costs: ArbCosts,
): ArbOpportunity | null {
  if (!(xReserve > 0) || !(yReserve > 0) || !(externalMid > 0)) return null;
  const f = costs.poolFeeBps / 10_000;
  const flashBps = costs.flashFeeBps ?? FLASH_FEE_BPS;
  const gasY = costs.gasY ?? 0;
  const g = 1 - f;
  const P = externalMid;
  const mid = yReserve / xReserve;
  const divergenceBps = (Math.abs(mid - P) / P) * 10_000;

  let direction: ArbOpportunity["direction"];
  let amountIn: number;
  let amountOut: number;
  let grossEdgeY: number;
  let flashFeeY: number;

  if (P * g > mid) {
    // Pool underprices x: spend y, take x, value x at the external mid.
    direction = "buy-x";
    amountIn = (Math.sqrt(P * xReserve * yReserve * g) - yReserve) / g;
    amountOut = (xReserve * g * amountIn) / (yReserve + g * amountIn);
    grossEdgeY = amountOut * P - amountIn;
    flashFeeY = amountIn * (flashBps / 10_000);
  } else if (mid * g > P) {
    // Pool overprices x: spend x, take y, the x spent is valued at the external mid.
    direction = "sell-x";
    amountIn = (Math.sqrt((xReserve * yReserve * g) / P) - xReserve) / g;
    amountOut = (yReserve * g * amountIn) / (xReserve + g * amountIn);
    grossEdgeY = amountOut - amountIn * P;
    flashFeeY = amountIn * P * (flashBps / 10_000);
  } else {
    return null; // divergence inside the fee band — no edge exists
  }

  if (!(amountIn > 0)) return null;
  const netEdgeY = grossEdgeY - flashFeeY - gasY;
  if (netEdgeY <= 0) return null;
  return { direction, amountIn, amountOut, grossEdgeY, flashFeeY, gasY, netEdgeY, divergenceBps };
}
