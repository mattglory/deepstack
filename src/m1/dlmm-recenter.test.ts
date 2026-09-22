// Unit tests for the DLMM recenter decision core. Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecenter, minDlpFromExpected, minOutFromExpected, expectedDlp } from "./dlmm-recenter.js";

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

test("expectedDlp: empty bin (bin-shares=0) — sqrt(value) minus the one-time burn", () => {
  // binPrice = 1e8 (price 1.0), x=1000, y=2000 → addValue = 1e8*1000 + 2000*1e8 = 3e11, isqrt = 547722
  const bin = { xBalance: 0n, yBalance: 0n, binShares: 0n, binPrice: 100_000_000n };
  assert.equal(expectedDlp(1000n, 2000n, bin, 1000n), 546_722n);
});

test("expectedDlp: empty bin — burn can't take the result negative", () => {
  const bin = { xBalance: 0n, yBalance: 0n, binShares: 0n, binPrice: 100_000_000n };
  assert.equal(expectedDlp(1n, 0n, bin, 1_000_000n), 0n); // tiny deposit, huge burn → floored at 0, not negative
});

test("expectedDlp: occupied bin — value-proportional share of existing bin-shares", () => {
  // same addValue (3e11) into a bin already holding value 3e12 at 500000 shares → 1/10 of shares
  const bin = { xBalance: 10_000n, yBalance: 20_000n, binShares: 500_000n, binPrice: 100_000_000n };
  assert.equal(expectedDlp(1000n, 2000n, bin, 1000n), 50_000n);
});

test("expectedDlp: occupied bin with zero recorded value falls back to sqrt(value), like the core does", () => {
  const bin = { xBalance: 0n, yBalance: 0n, binShares: 500_000n, binPrice: 100_000_000n };
  assert.equal(expectedDlp(1000n, 2000n, bin, 1000n), 547_722n); // no burn subtracted — only the bin-shares=0 branch burns
});

test("expectedDlp: matches the class of bin that broke on 2026-09-21 — thin outer bins mint far fewer shares than a flat 10000 floor allows", () => {
  // A small slice of a $150 deposit landing in a bin that already holds much more value than
  // the slice being added mints proportionally few shares — this is exactly why a single flat
  // min-dlp for every bin in a multi-position add aborted the whole transaction.
  const thinSlice = { xAmount: 8n, yAmount: 15n }; // a tiny per-bin slice, ~$150 spread over 100+ bins
  const bin = { xBalance: 1_000_000n, yBalance: 2_000_000n, binShares: 50_000_000n, binPrice: 100_000_000n };
  const dlp = expectedDlp(thinSlice.xAmount, thinSlice.yAmount, bin, 1000n);
  assert.ok(dlp < 10_000n, `expected a thin slice to mint under the old flat floor, got ${dlp}`);
  assert.ok(dlp > 0n, "still a real, valid, nonzero mint — min-dlp just needs to fit it, not exclude it");
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

test("sizeTwoSidedDeposit: 8-decimal X (sBTC) prices and scales correctly", () => {
  // $200 target, sBTC @ $65k, ample balances → ~$100 sBTC (8dp) + ~$100 USDCx (6dp)
  const s = sizeTwoSidedDeposit(200, 65000, 10n ** 12n, 10n ** 12n, 8, 6);
  assert.equal(s.yBase, 100_000_000n); // $100 USDCx at 6dp
  assert.equal(s.xBase, BigInt(Math.floor((100 / 65000) * 1e8))); // ~0.001538 sBTC at 8dp
  assert.ok(Math.abs(s.valueUsd - 200) < 0.5);
});

test("sizeTwoSidedDeposit: 8-decimal X respects an sBTC balance cap", () => {
  // only 0.001 sBTC (100000 at 8dp) available → X side capped there
  const s = sizeTwoSidedDeposit(200, 65000, 100_000n, 10n ** 12n, 8, 6);
  assert.equal(s.xBase, 100_000n);
});
