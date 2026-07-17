// Unit tests for the LVR estimator. Run: npm test
//
// The first test pins the sigma^2/8 closed form to the published worked example, so a
// future refactor can't silently change the economics this project reports.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  realizedVolDaily,
  lvrRateBpsPerDay,
  cumulativeLvrY,
  breakEvenDailyVolume,
  estimateLvr,
  type MidPoint,
} from "./lvr.js";

// Build a mid series from daily log-returns, starting at `start`.
const series = (start: number, dailyLogReturns: number[], lpValueY = 1000): MidPoint[] => {
  const pts: MidPoint[] = [{ t: "2026-01-01T00:00:00Z", mid: start, lpValueY }];
  let mid = start;
  dailyLogReturns.forEach((r, i) => {
    mid = mid * Math.exp(r);
    pts.push({ t: new Date(Date.UTC(2026, 0, 2 + i)).toISOString(), mid, lpValueY });
  });
  return pts;
};

test("lvrRateBpsPerDay: matches the published worked example (5%/day -> 3.125 bps/day)", () => {
  // a16z: "if ETH-USDC volatility is 5% daily, the pool loses sigma^2/8 = 3.125 bps daily"
  assert.ok(Math.abs(lvrRateBpsPerDay(0.05) - 3.125) < 1e-9);
});

test("lvrRateBpsPerDay: scales with the square of volatility", () => {
  // doubling vol quadruples the bleed — the reason vol regime dominates LP economics
  assert.ok(Math.abs(lvrRateBpsPerDay(0.10) - 4 * lvrRateBpsPerDay(0.05)) < 1e-9);
});

test("realizedVolDaily: recovers the volatility of a known series", () => {
  // constant |r| = 2% per day => sigma_daily = 2%
  const sigma = realizedVolDaily(series(100, [0.02, -0.02, 0.02, -0.02]));
  assert.ok(sigma !== null);
  assert.ok(Math.abs(sigma! - 0.02) < 1e-9, `expected ~0.02, got ${sigma}`);
});

test("realizedVolDaily: null when there is nothing to measure", () => {
  assert.equal(realizedVolDaily([]), null);
  assert.equal(realizedVolDaily([{ t: "2026-01-01T00:00:00Z", mid: 100, lpValueY: 10 }]), null);
});

test("realizedVolDaily: ignores duplicate/out-of-order timestamps rather than dividing by zero", () => {
  const pts: MidPoint[] = [
    { t: "2026-01-01T00:00:00Z", mid: 100, lpValueY: 10 },
    { t: "2026-01-01T00:00:00Z", mid: 101, lpValueY: 10 }, // dt = 0
  ];
  assert.equal(realizedVolDaily(pts), null);
});

test("cumulativeLvrY: flat price costs nothing", () => {
  assert.equal(cumulativeLvrY(series(100, [0, 0, 0])), 0);
});

test("cumulativeLvrY: sums (r^2/8)*lpValue over the window", () => {
  const pts = series(100, [0.02, -0.02], 1000);
  // two intervals, |r| = 0.02, V = 1000 -> 2 * (0.0004/8) * 1000 = 0.1
  assert.ok(Math.abs(cumulativeLvrY(pts) - 0.1) < 1e-9);
});

test("cumulativeLvrY: no LP position, no LVR (it is a cost of being in the pool)", () => {
  assert.equal(cumulativeLvrY(series(100, [0.05, -0.05], 0)), 0);
});

test("cumulativeLvrY: scales linearly with LP value", () => {
  const small = cumulativeLvrY(series(100, [0.03, -0.01], 1_000));
  const big = cumulativeLvrY(series(100, [0.03, -0.01], 10_000));
  assert.ok(Math.abs(big - 10 * small) < 1e-9);
});

test("breakEvenDailyVolume: fee income exactly offsets LVR at the returned volume", () => {
  const sigma = 0.04, poolValue = 281_000, feeBps = 50;
  const vol = breakEvenDailyVolume(sigma, poolValue, feeBps);
  const feesAtBreakEven = vol * (feeBps / 10_000); // pool-wide fee income
  const lvrPerDay = ((sigma * sigma) / 8) * poolValue; // pool-wide LVR
  assert.ok(Math.abs(feesAtBreakEven - lvrPerDay) < 1e-6);
});

test("breakEvenDailyVolume: a fatter fee lowers the volume needed to survive", () => {
  const hi = breakEvenDailyVolume(0.04, 281_000, 30);
  const lo = breakEvenDailyVolume(0.04, 281_000, 50);
  assert.ok(lo < hi);
});

test("breakEvenDailyVolume: degenerate inputs return 0 rather than Infinity/NaN", () => {
  assert.equal(breakEvenDailyVolume(0.04, 281_000, 0), 0);
  assert.equal(breakEvenDailyVolume(0.04, 0, 50), 0);
});

test("estimateLvr: reports window, vol and cost together", () => {
  const e = estimateLvr(series(100, [0.02, -0.02, 0.01]));
  assert.equal(e.samples, 3);
  assert.ok(Math.abs(e.windowDays - 3) < 1e-9);
  assert.ok(e.sigmaDaily !== null && e.sigmaDaily > 0);
  assert.ok(e.cumulativeLvrY > 0);
});

test("estimateLvr: degrades safely on an empty series", () => {
  const e = estimateLvr([]);
  assert.equal(e.samples, 0);
  assert.equal(e.sigmaDaily, null);
  assert.equal(e.lvrRateBpsPerDay, null);
  assert.equal(e.cumulativeLvrY, 0);
});
