// Unit tests for the stSTX gap estimator's pure core. Run: npm test
//
// The executability gate is the point: a quote is not a fill. These pin the arithmetic
// and the rule that an arb counts only when BOTH legs can actually swap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gapMetrics, bothApproved } from "./ststx-gap.js";

test("gapMetrics: a flat round trip never shows a profit (fees + gas are a floor cost)", () => {
  const m = gapMetrics(100_000_000, 100_000_000);
  assert.equal(m.grossBps, 0);
  assert.ok(m.netStx < 0, `flat trip must be net-negative, got ${m.netStx}`);
});

test("gapMetrics: a real gross gap nets out after flash fee + gas", () => {
  // 100 STX in, 119 STX back: 19% gross; net = 19 - flashFee(0.05% of 100 = 0.05) - gas(0.1)
  const m = gapMetrics(100_000_000, 119_000_000);
  assert.equal(m.grossBps, 1900);
  assert.ok(Math.abs(m.netStx - 18.85) < 1e-6, `expected 18.85, got ${m.netStx}`);
});

test("gapMetrics: grossBps is signed — the reverse direction is a loss", () => {
  assert.ok(gapMetrics(100_000_000, 84_000_000).grossBps < 0);
});

test("bothApproved: an arb is executable only when BOTH legs' pairs are approved", () => {
  assert.equal(bothApproved(true, true), true);
  assert.equal(bothApproved(true, false), false); // sell leg de-listed
  assert.equal(bothApproved(false, true), false); // buy leg de-listed (the v-1-1 case)
  assert.equal(bothApproved(false, false), false);
});
