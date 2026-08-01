// Tests for the bigint-safe constant-product mid (bug-class-3 hardening).
// The decisive properties: unchanged at today's reserve sizes, and not subject to the 2^53
// Number() precision boundary that the naive `Number(base)/10^dec` ratio silently crosses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { midFromReserves } from "./pool.js";

test("midFromReserves: identical to the naive Number ratio at live reserve sizes", () => {
  // sBTC-STX: x ~= 1.96 sBTC (8dp), y ~= 770,008 STX (6dp)
  const x = 196033231n;
  const y = 770008000000n;
  const naive = Number(y) / 1e6 / (Number(x) / 1e8);
  const safe = midFromReserves(x, y, 8, 6);
  assert.ok(Math.abs(safe - naive) / naive < 1e-9, `naive ${naive} vs safe ${safe}`);
});

test("Number() drops integer precision above 2^53 (the reason this is done in BigInt)", () => {
  const overBoundary = (1n << 53n) + 1n; // 9,007,199,254,740,993
  // Direct proof the boundary is real: 2^53 + 1 is not representable as a double.
  assert.equal(Number(overBoundary), Number(1n << 53n));
  // A reserve at this magnitude divides in BigInt first, so the mid reflects the true reserve,
  // not the value Number() would have rounded it to.
  const safe = midFromReserves(1_000_000n, overBoundary, 6, 6); // decimals cancel: mid = y/x
  const exact = Number((overBoundary * 1_000_000_000n) / 1_000_000n) / 1e9;
  assert.ok(Math.abs(safe - exact) < 1e-6, `safe ${safe} vs exact ${exact}`);
});

test("midFromReserves: empty x-reserve returns 0, not Infinity", () => {
  assert.equal(midFromReserves(0n, 1000n, 6, 6), 0);
});
