// Unit tests for divergence capture — the flash-rebalance sizing core.
//
// The load-bearing claim is the closed-form optimum, so the tests verify it against a
// brute-force grid search over trade sizes rather than trusting the algebra.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findArb } from "./arb.js";

// Pilot-shaped pool: ~4.5 sBTC + 1.7M STX, mid ≈ 377k STX/sBTC, 50bps fee.
const X = 4.5;
const Y = 1_700_000;
const MID = Y / X;
const FEE = { poolFeeBps: 50 };

// Simulate the pool payoff for a given input, to cross-check the optimum.
function payoffBuyX(dy: number, P: number, f = 0.005): number {
  const xOut = (X * (1 - f) * dy) / (Y + (1 - f) * dy);
  return xOut * P - dy;
}
function payoffSellX(dx: number, P: number, f = 0.005): number {
  const yOut = (Y * (1 - f) * dx) / (X + (1 - f) * dx);
  return yOut - dx * P;
}

test("arb: divergence inside the fee band → null (the normal case)", () => {
  assert.equal(findArb(X, Y, MID, FEE), null); // no divergence at all
  assert.equal(findArb(X, Y, MID * 1.003, FEE), null); // 30bps < 50bps fee
  assert.equal(findArb(X, Y, MID * 0.997, FEE), null);
});

test("arb: pool underprices x → buy-x, and the closed form beats every grid point", () => {
  const P = MID * 1.02; // external 2% above pool
  const opp = findArb(X, Y, P, { poolFeeBps: 50, flashFeeBps: 0, gasY: 0 });
  assert.ok(opp && opp.direction === "buy-x");
  assert.ok(Math.abs(opp.divergenceBps - 10_000 * (0.02 / 1.02)) < 1);
  // Grid search: no trade size does better than the claimed optimum.
  for (let frac = 0.05; frac <= 3; frac += 0.05) {
    assert.ok(payoffBuyX(opp.amountIn * frac, P) <= opp.grossEdgeY + 1e-6);
  }
  assert.ok(Math.abs(payoffBuyX(opp.amountIn, P) - opp.grossEdgeY) < 1e-6);
});

test("arb: pool overprices x → sell-x, optimum verified by grid search", () => {
  const P = MID * 0.98;
  const opp = findArb(X, Y, P, { poolFeeBps: 50, flashFeeBps: 0, gasY: 0 });
  assert.ok(opp && opp.direction === "sell-x");
  for (let frac = 0.05; frac <= 3; frac += 0.05) {
    assert.ok(payoffSellX(opp.amountIn * frac, P) <= opp.grossEdgeY + 1e-6);
  }
});

test("arb: flash fee and gas are subtracted, and can kill a marginal edge", () => {
  const P = MID * 1.0075; // 75bps divergence — just past the 50bps fee band
  const free = findArb(X, Y, P, { poolFeeBps: 50, flashFeeBps: 0, gasY: 0 });
  assert.ok(free && free.netEdgeY > 0);
  const costed = findArb(X, Y, P, { poolFeeBps: 50, flashFeeBps: 5, gasY: 0.05 });
  if (costed) {
    assert.ok(costed.netEdgeY < free.netEdgeY);
    assert.ok(Math.abs(costed.netEdgeY - (costed.grossEdgeY - costed.flashFeeY - 0.05)) < 1e-9);
  }
  // A big enough gas bill always kills it.
  assert.equal(findArb(X, Y, P, { poolFeeBps: 50, gasY: 1e9 }), null);
});

test("arb: a real divergence nets out positive after all costs", () => {
  const P = MID * 1.03; // 3% — the kind of gap LVR says arbitrageurs feed on
  const opp = findArb(X, Y, P, { poolFeeBps: 50, gasY: 0.05 });
  assert.ok(opp);
  assert.ok(opp.netEdgeY > 0);
  assert.ok(opp.grossEdgeY > opp.netEdgeY);
  // Sanity: the trade is a meaningful fraction of the pool, not dust and not the pool.
  assert.ok(opp.amountIn > 0 && opp.amountIn < Y);
});

test("arb: degenerate inputs → null, never NaN or a throw", () => {
  assert.equal(findArb(0, Y, MID, FEE), null);
  assert.equal(findArb(X, 0, MID, FEE), null);
  assert.equal(findArb(X, Y, 0, FEE), null);
  assert.equal(findArb(X, Y, NaN, FEE), null);
});
