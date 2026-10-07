// Unit tests for the dashboard's P&L / IL-adjusted-return math (external review, issue #7
// — this was previously untestable: the logic lived inline in index.html's <script> with no
// way to import it without a DOM). Plain Node --test, no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hodlNow, ilAdjustedReturn, isPlausibleAgainstHodl, organicApr } from "./pnl-math.js";

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

// organicApr: extracted from index.html's two formerly-duplicated lpApr/dlmmApr blocks —
// these tests pin the exact formula so a future edit can't silently diverge the two call
// sites (XYK, native-STX y-leg) and (DLMM, USDCx y-leg needing yLegUsdRate) again.
const tenDaysAgo = new Date(Date.now() - 10 * 864e5).toISOString();

test("organicApr: native-STX y-leg (XYK-style), no gain → net 0, apr 0 once past minDays", () => {
  const r = organicApr({ currentValueY: 100, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 1 });
  assert.equal(r.netY, 0);
  assert.equal(r.apr, 0);
});

test("organicApr: native-STX y-leg with a real gain → annualised correctly", () => {
  // hodlLegs = 0*1 + 100 = 100; net = 110-100 = 10; apr = (10/100)*(365/10)*100 = 365%
  const r = organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 1 });
  assert.equal(r.netY, 10);
  assert.equal(Math.round(r.apr), 365);
});

test("organicApr: USDCx y-leg (DLMM-style) converts via yLegUsdRate, not used raw", () => {
  // basisYQty=50 USDCx, stxUsd rate 0.5 → yLegY = 50/0.5 = 100 STX-equivalent; hodlLegs = 0+100
  const r = organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 50, basisT: tenDaysAgo, mid: 1, yLegUsdRate: 0.5 });
  assert.equal(r.netY, 10);
  assert.equal(Math.round(r.apr), 365);
});

test("organicApr: net is computed even before minDays, but apr stays null (annualising a short window is how LP marketing lies)", () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 864e5).toISOString();
  const r = organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: twoDaysAgo, mid: 1 });
  assert.equal(r.netY, 10);
  assert.equal(r.apr, null);
});

test("organicApr: missing mid, currentValueY, basis quantities, or basisT → all null, never a fabricated number", () => {
  assert.deepEqual(organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 0 }), { netY: null, apr: null, days: 0 });
  assert.deepEqual(organicApr({ currentValueY: 0, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 1 }), { netY: null, apr: null, days: 0 });
  assert.deepEqual(organicApr({ currentValueY: 110, basisXQty: null, basisYQty: 100, basisT: tenDaysAgo, mid: 1 }), { netY: null, apr: null, days: 0 });
  assert.deepEqual(organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: null, mid: 1 }), { netY: null, apr: null, days: 0 });
});

test("organicApr: a non-positive yLegUsdRate is a guard failure, not a divide-by-zero/negative", () => {
  const r = organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 1, yLegUsdRate: 0 });
  assert.deepEqual(r, { netY: null, apr: null, days: 0 });
});
