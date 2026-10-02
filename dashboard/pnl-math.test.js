// Unit tests for the dashboard's P&L / IL-adjusted-return math (external review, issue #7
// — this was previously untestable: the logic lived inline in index.html's <script> with no
// way to import it without a DOM). Plain Node --test, no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hodlNow, ilAdjustedReturn, isPlausibleAgainstHodl } from "./pnl-math.js";

const baseline = { xBase: "10000000000", yBase: "0" }; // 100 sBTC-equivalent units at 8dp, 0 STX
const sample = (over = {}) => ({ mid: 200000, stxUsd: 0.5, portfolioY: 100, ...over });

test("hodlNow: no pilotBaseline on the metrics file → null", () => {
  assert.equal(hodlNow({}, sample()), null);
});

test("hodlNow: a sample with no mid yet (0 or missing) → null", () => {
  assert.equal(hodlNow({ pilotBaseline: baseline }, sample({ mid: 0 })), null);
});

test("hodlNow: values the x+y baseline legs at the sample's mid", () => {
  // 100 units of X (8dp) * mid 200000 + 0 Y = 100 * 200000 = 20,000,000
  const v = hodlNow({ pilotBaseline: baseline }, sample());
  assert.equal(v, 100 * 200000);
});

test("hodlNow: adds LP basis legs (fixed pilotBaseline.lpBasis, not the mutable top-level one)", () => {
  const m = {
    pilotBaseline: { ...baseline, lpBasis: { xQty: 1, yQty: 50 } },
    lpBasis: { xQty: 999, yQty: 999 }, // mutable, evolved since — must NOT be used here
  };
  const v = hodlNow(m, sample());
  assert.equal(v, 100 * 200000 + 1 * 200000 + 50);
});

test("hodlNow: falls back to the mutable lpBasis only when pilotBaseline has none (pre-snapshot metrics files)", () => {
  const m = { pilotBaseline: baseline, lpBasis: { xQty: 2, yQty: 10 } };
  const v = hodlNow(m, sample());
  assert.equal(v, 100 * 200000 + 2 * 200000 + 10);
});

test("hodlNow: DLMM basis's Y leg (USDCx) needs stxUsd to value — null when the sample lacks it", () => {
  const m = { pilotBaseline: { ...baseline, dlmmBasis: { xQty: 0, yQty: 50 } } };
  assert.equal(hodlNow(m, sample({ stxUsd: 0 })), null);
});

test("hodlNow: values DLMM's X leg at mid and Y leg (USDCx) via stxUsd", () => {
  const m = { pilotBaseline: { ...baseline, dlmmBasis: { xQty: 0.001, yQty: 50 } } };
  const v = hodlNow(m, sample());
  // base legs + dlmm X (0.001 * mid) + dlmm Y (50 USDCx / stxUsd)
  assert.equal(v, 100 * 200000 + 0.001 * 200000 + 50 / 0.5);
});

test("hodlNow: pilotBaseline.usdcxQty (free USDCx at pilot start) also needs stxUsd", () => {
  const m = { pilotBaseline: { ...baseline, usdcxQty: 20 } };
  const v = hodlNow(m, sample());
  assert.equal(v, 100 * 200000 + 20 / 0.5);
  assert.equal(hodlNow(m, sample({ stxUsd: 0 })), null);
});

test("ilAdjustedReturn: null when hodlNow can't be computed", () => {
  assert.equal(ilAdjustedReturn({}, sample()), null);
});

test("ilAdjustedReturn: positive when the portfolio beats the HODL baseline", () => {
  const m = { pilotBaseline: baseline };
  const hodl = hodlNow(m, sample()); // 20,000,000
  const r = ilAdjustedReturn(m, sample({ portfolioY: hodl * 1.1 }));
  assert.ok(Math.abs(r - 10) < 1e-9);
});

test("ilAdjustedReturn: negative when the portfolio trails the HODL baseline", () => {
  const m = { pilotBaseline: baseline };
  const hodl = hodlNow(m, sample());
  const r = ilAdjustedReturn(m, sample({ portfolioY: hodl * 0.95 }));
  assert.ok(Math.abs(r - -5) < 1e-9);
});

test("isPlausibleAgainstHodl: within the default 20% band → plausible", () => {
  assert.equal(isPlausibleAgainstHodl(105, 100), true);
  assert.equal(isPlausibleAgainstHodl(119, 100), true);
});

test("isPlausibleAgainstHodl: beyond the band → filtered out (a failed-read glitch, not real IL)", () => {
  assert.equal(isPlausibleAgainstHodl(150, 100), false);
  assert.equal(isPlausibleAgainstHodl(50, 100), false);
});

test("isPlausibleAgainstHodl: a null or non-positive hodl is never plausible (nothing to compare against)", () => {
  assert.equal(isPlausibleAgainstHodl(100, null), false);
  assert.equal(isPlausibleAgainstHodl(100, 0), false);
  assert.equal(isPlausibleAgainstHodl(100, -5), false);
});

test("isPlausibleAgainstHodl: the threshold is configurable (used with pnl-math's own default of 0.2 by callers that don't override it)", () => {
  assert.equal(isPlausibleAgainstHodl(130, 100, 0.5), true);
  assert.equal(isPlausibleAgainstHodl(130, 100, 0.2), false);
});
