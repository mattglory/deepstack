// Unit tests for the DLMM recenter decision core. Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecenter, minDlpFromExpected, minOutFromExpected } from "./dlmm-recenter.js";

test("decideRecenter: no position → open a band around the active bin", () => {
  const d = decideRecenter(-236, { lo: null, hi: null }, 5);
  assert.equal(d.action, "open");
  assert.equal(d.targetLo, -241);
  assert.equal(d.targetHi, -231);
  assert.equal(d.center, -236);
});

test("decideRecenter: active still inside the band → hold", () => {
  // position centered at -236 (±5 => [-241,-231]); active at -238 is well inside
  const d = decideRecenter(-238, { lo: -241, hi: -231 }, 5);
  assert.equal(d.action, "hold");
});

test("decideRecenter: active past the edge beyond hysteresis → recenter", () => {
  // center -236, halfWidth 5, hysteresis 1 => recenter when drift > 6. active -229 => drift 7.
  const d = decideRecenter(-229, { lo: -241, hi: -231 }, 5, 1);
  assert.equal(d.action, "recenter");
  assert.equal(d.targetLo, -234); // new band around -229
  assert.equal(d.targetHi, -224);
});

test("decideRecenter: hysteresis prevents thrashing right at the edge", () => {
  // center -236, halfWidth 5 => edge at drift 5; hysteresis 1 => hold until drift > 6.
  assert.equal(decideRecenter(-231, { lo: -241, hi: -231 }, 5, 1).action, "hold"); // drift 5
  assert.equal(decideRecenter(-230, { lo: -241, hi: -231 }, 5, 1).action, "hold"); // drift 6
  assert.equal(decideRecenter(-229, { lo: -241, hi: -231 }, 5, 1).action, "recenter"); // drift 7
});

test("decideRecenter: halfWidth floored to at least 1 bin", () => {
  const d = decideRecenter(0, { lo: null, hi: null }, 0);
  assert.equal(d.targetLo, -1);
  assert.equal(d.targetHi, 1);
});

test("minDlpFromExpected: applies slippage but never drops below the floor", () => {
  assert.equal(minDlpFromExpected(1_000_000n, 100, 10_000n), 990_000n); // 1% off
  assert.equal(minDlpFromExpected(10_000n, 100, 10_000n), 10_000n); // slip would go under floor → floor
  assert.equal(minDlpFromExpected(5_000n, 0, 10_000n), 10_000n); // below floor even at 0 slip → floor
});

test("minOutFromExpected: value side gets a positive min; empty side is 0", () => {
  assert.equal(minOutFromExpected(2_010_053n, 100), 1_989_953n); // ~1% slippage
  assert.equal(minOutFromExpected(0n, 100), 0n); // empty side → 0 (min-sum>0 satisfied by the other leg)
  assert.equal(minOutFromExpected(50n, 10_000), 1n); // 100% slip floored to 1 (a value side must assert ≥1)
});

import { sizeTwoSidedDeposit } from "./dlmm-recenter.js";

test("sizeTwoSidedDeposit: ~50/50 by value when balances are ample", () => {
  // target $200, STX @ $0.14, plenty of both → ~$100 each side
  const s = sizeTwoSidedDeposit(200, 0.14, 10_000_000_000n, 10_000_000_000n);
  assert.equal(s.yBase, 100_000_000n); // $100 USDCx
  assert.equal(s.xBase, BigInt(Math.floor((100 / 0.14) * 1e6))); // ~714.28 STX
  assert.ok(Math.abs(s.valueUsd - 200) < 0.01);
});

test("sizeTwoSidedDeposit: caps each side by available balance (lopsided, no swap)", () => {
  // only 30 USDCx available → Y side capped; X side still ~$100
  const s = sizeTwoSidedDeposit(200, 0.14, 10_000_000_000n, 30_000_000n);
  assert.equal(s.yBase, 30_000_000n); // all the USDCx there is
  assert.equal(s.xBase, BigInt(Math.floor((100 / 0.14) * 1e6)));
});

test("sizeTwoSidedDeposit: degenerate inputs → zero, never NaN/negative", () => {
  assert.deepEqual(sizeTwoSidedDeposit(0, 0.14, 1n, 1n), { xBase: 0n, yBase: 0n, valueUsd: 0 });
  assert.deepEqual(sizeTwoSidedDeposit(200, 0, 1n, 1n), { xBase: 0n, yBase: 0n, valueUsd: 0 });
});
