// Tests for the DLMM read-only adapter's pure math. The I/O reads are exercised live via
// dlmm-cli.ts; here we lock the deterministic helpers that later sizing will depend on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { binPriceMultiplier, sumBinWindow, binUintKey } from "./dlmm-read.js";

test("binUintKey: signed→uint via +CENTER_BIN_ID (500), verified on-chain", () => {
  assert.equal(binUintKey(0), 500); // centre
  assert.equal(binUintKey(7), 507); // ststx-stx active bin verified live
  assert.equal(binUintKey(-37), 463); // sbtc-usdcx active bin verified live
  assert.equal(binUintKey(-194), 306); // stx-usdcx active bin verified live
  assert.equal(binUintKey(-500), 0); // lowest valid bin
  assert.equal(binUintKey(500), 1000); // highest valid bin
});

test("binPriceMultiplier: bin 0 is unity; step compounds per bin", () => {
  assert.equal(binPriceMultiplier(0, 1), 1);
  // 1bp step, one bin up = +0.01%
  assert.ok(Math.abs(binPriceMultiplier(1, 1) - 1.0001) < 1e-9);
  // 10bp step, 47 bins up compounds
  assert.ok(binPriceMultiplier(47, 10) > binPriceMultiplier(47, 1));
  // symmetry: down a bin is the reciprocal direction (still > 0, < 1)
  assert.ok(binPriceMultiplier(-5, 10) < 1 && binPriceMultiplier(-5, 10) > 0);
});

test("sumBinWindow: totals balances and counts only non-empty bins", () => {
  const r = sumBinWindow([
    { x: 100n, y: 0n },
    { x: 0n, y: 0n }, // empty — counted in total (0) but not as liquidity
    null, // failed read — skipped
    { x: 0n, y: 276n },
  ]);
  assert.equal(r.xTotal, 100n);
  assert.equal(r.yTotal, 276n);
  assert.equal(r.binsWithLiquidity, 2);
});

test("sumBinWindow: all-empty / all-null is zero, not a throw", () => {
  assert.deepEqual(sumBinWindow([null, null]), { xTotal: 0n, yTotal: 0n, binsWithLiquidity: 0 });
  assert.deepEqual(sumBinWindow([]), { xTotal: 0n, yTotal: 0n, binsWithLiquidity: 0 });
});
