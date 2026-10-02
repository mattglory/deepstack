// Unit tests for the autonomous flash-rebalance sizing/sequencing logic — pure, no chain, no
// wallet. These pin down the two properties that matter most for a mechanism that moves real
// money: it never sizes beyond what can actually be covered, and it never claims success
// without both broadcast steps confirming.

import { test } from "node:test";
import assert from "node:assert/strict";
import { flashFee, sizeFlashRebalance, flashRebalanceSequenceOutcome } from "./flash-rebalance.js";

test("flashFee: 5bps of the amount", () => {
  assert.equal(flashFee(1_000_000_000n), 500_000n); // 1000 STX -> 0.5 STX fee
});

test("flashFee: floors at 1 µSTX rather than rounding to zero", () => {
  assert.equal(flashFee(1n), 1n);
  assert.equal(flashFee(0n), 1n);
});

const baseOpts = {
  maxAmountBase: 150_000_000n, // 150 STX
  maxSingleLoan: 1_000_000_000n, // 1000 STX, roomy
  reserveBalance: 1_000_000_000n,
  availableNativeStxBase: 500_000_000n, // 500 STX
  gasReserveBase: 5_000_000n, // 5 STX
  directCapBase: 50_000_000n, // 50 STX
};

test("sizeFlashRebalance: no deficit -> not worthwhile", () => {
  const r = sizeFlashRebalance(0n, baseOpts);
  assert.equal(r.worthwhile, false);
  assert.equal(r.amountBase, 0n);
});

test("sizeFlashRebalance: deficit under the direct cap -> not worthwhile (the direct swap already covers it)", () => {
  const r = sizeFlashRebalance(30_000_000n, baseOpts); // 30 STX < 50 STX direct cap
  assert.equal(r.worthwhile, false);
});

test("sizeFlashRebalance: deficit over the direct cap, everything else roomy -> sizes to the full deficit", () => {
  const r = sizeFlashRebalance(100_000_000n, baseOpts); // 100 STX
  assert.equal(r.worthwhile, true);
  assert.equal(r.amountBase, 100_000_000n);
});

test("sizeFlashRebalance: clamped by the configured cap", () => {
  const r = sizeFlashRebalance(999_000_000n, baseOpts); // huge deficit
  assert.equal(r.amountBase, baseOpts.maxAmountBase); // 150 STX
  assert.equal(r.worthwhile, true);
});

test("sizeFlashRebalance: clamped by FlashStack's own max-single-loan", () => {
  const r = sizeFlashRebalance(999_000_000n, { ...baseOpts, maxSingleLoan: 80_000_000n });
  assert.equal(r.amountBase, 80_000_000n);
  assert.equal(r.worthwhile, true);
});

test("sizeFlashRebalance: clamped by FlashStack's own reserve balance", () => {
  const r = sizeFlashRebalance(999_000_000n, { ...baseOpts, reserveBalance: 60_000_000n });
  assert.equal(r.amountBase, 60_000_000n);
});

test("sizeFlashRebalance: clamped by wallet balance minus the gas reserve", () => {
  const r = sizeFlashRebalance(999_000_000n, { ...baseOpts, availableNativeStxBase: 70_000_000n, gasReserveBase: 5_000_000n });
  assert.equal(r.amountBase, 65_000_000n); // 70 - 5
});

test("sizeFlashRebalance: after all clamps the result still isn't bigger than the direct cap -> not worthwhile, don't pay the fee for nothing", () => {
  const r = sizeFlashRebalance(999_000_000n, { ...baseOpts, availableNativeStxBase: 55_000_000n, gasReserveBase: 5_000_000n });
  // usable balance = 50 STX, exactly the direct cap
  assert.equal(r.amountBase, 50_000_000n);
  assert.equal(r.worthwhile, false);
});

test("sizeFlashRebalance: zero or negative usable balance -> 0n, not worthwhile, never throws", () => {
  const r1 = sizeFlashRebalance(100_000_000n, { ...baseOpts, availableNativeStxBase: 3_000_000n, gasReserveBase: 5_000_000n });
  assert.equal(r1.amountBase, 0n);
  assert.equal(r1.worthwhile, false);
  const r2 = sizeFlashRebalance(100_000_000n, { ...baseOpts, availableNativeStxBase: 0n, gasReserveBase: 0n });
  assert.equal(r2.amountBase, 0n);
  assert.equal(r2.worthwhile, false);
});

test("flashRebalanceSequenceOutcome: arm fails -> never attempts the flash-loan call", () => {
  const r = flashRebalanceSequenceOutcome("abort_by_response", null);
  assert.equal(r.executed, false);
  assert.match(r.reason, /arm abort_by_response.*aborted before the flash-loan call/);
});

test("flashRebalanceSequenceOutcome: arm succeeds, flash status null -> not executed, fails closed", () => {
  const r = flashRebalanceSequenceOutcome("success", null);
  assert.equal(r.executed, false);
  assert.match(r.reason, /armed successfully but no flash-loan call was attempted/);
});

test("flashRebalanceSequenceOutcome: both succeed -> executed", () => {
  const r = flashRebalanceSequenceOutcome("success", "success");
  assert.equal(r.executed, true);
  assert.equal(r.reason, "flash-rebalanced");
});

test("flashRebalanceSequenceOutcome: arm succeeds but the flash-loan call aborts/expires -> not executed", () => {
  const r = flashRebalanceSequenceOutcome("success", "abort_by_response");
  assert.equal(r.executed, false);
  assert.match(r.reason, /flash-loan abort_by_response/);
});
