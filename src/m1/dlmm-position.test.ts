// Tests for the DLMM position model's pure logic: volatility→bin-range sizing (the decisive new
// parameter concentrated liquidity needs) and the prorated-share math. The on-chain read is
// exercised live; here we lock the math the rebalance layer will depend on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { binRangeFromVol, proratePosition } from "./dlmm-position.js";

test("binRangeFromVol: higher volatility → wider range (more bins)", () => {
  const calm = binRangeFromVol(0.005, 10); // 0.5%/day
  const wild = binRangeFromVol(0.05, 10); // 5%/day
  assert.ok(wild.halfWidthBins > calm.halfWidthBins);
  assert.ok(wild.rangeBps > calm.rangeBps);
});

test("binRangeFromVol: finer bin-step → more bins for the same price range", () => {
  const coarse = binRangeFromVol(0.03, 10); // 10bp bins
  const fine = binRangeFromVol(0.03, 1); // 1bp bins
  assert.ok(fine.halfWidthBins > coarse.halfWidthBins);
  // same underlying price range, just measured in more (finer) bins
  assert.ok(Math.abs(fine.rangeBps - coarse.rangeBps) <= 2);
});

test("binRangeFromVol: k-sigma and horizon scale the width as expected", () => {
  const base = binRangeFromVol(0.02, 10, { kSigmas: 2, horizonHours: 12 });
  const wider = binRangeFromVol(0.02, 10, { kSigmas: 4, horizonHours: 12 }); // 2x sigmas
  const longer = binRangeFromVol(0.02, 10, { kSigmas: 2, horizonHours: 48 }); // 4x time → 2x std
  assert.ok(Math.abs(wider.rangeBps - 2 * base.rangeBps) <= 2);
  assert.ok(Math.abs(longer.rangeBps - 2 * base.rangeBps) <= 2);
});

test("binRangeFromVol: clamped to at least 1 bin, at most the cap", () => {
  assert.equal(binRangeFromVol(0, 10).halfWidthBins, 1); // no vol → minimal, not zero
  assert.equal(binRangeFromVol(1e-9, 10).halfWidthBins, 1);
  const capped = binRangeFromVol(5, 1, { maxHalfWidthBins: 50 }); // absurd vol, fine bins
  assert.equal(capped.halfWidthBins, 50);
});

test("binRangeFromVol: a plausible sBTC-USDCx sizing (3%/day, 10bp bins)", () => {
  const r = binRangeFromVol(0.03, 10, { kSigmas: 2, horizonHours: 12 });
  // ~2 * 3% * sqrt(0.5) = ~4.24% one side → ~424bps → ~43 bins each side
  assert.ok(r.halfWidthBins >= 35 && r.halfWidthBins <= 50);
});

test("proratePosition: floors to the user's share, never over-credits", () => {
  // user owns half the bin's shares → half its x and y (floored)
  assert.deepEqual(proratePosition(50n, 100n, 1000n, 2000n), { x: 500n, y: 1000n });
  // rounding: 1/3 of 1000 floors to 333
  assert.deepEqual(proratePosition(1n, 3n, 1000n, 0n), { x: 333n, y: 0n });
  // zero-share / empty-bin guards
  assert.deepEqual(proratePosition(0n, 100n, 10n, 10n), { x: 0n, y: 0n });
  assert.deepEqual(proratePosition(50n, 0n, 10n, 10n), { x: 0n, y: 0n });
});
