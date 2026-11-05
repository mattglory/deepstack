// Unit tests for the DLMM width decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { binVolAtHorizon, backtestRecenters, recenterCostUsd, widthTable, recommendWidth } from "./dlmm-width.js";

const path = (bins: number[], stepDays = 1 / 48) => bins.map((bin, i) => ({ t: i * stepDays, bin }));

test("vol: a back-and-forth bounce is large at 30 minutes and small over a day", () => {
  const bounce = path(Array.from({ length: 480 }, (_, i) => (i % 2 ? 5 : 0)));
  assert.ok(binVolAtHorizon(bounce, 1 / 48)! > 30);
  assert.ok(binVolAtHorizon(bounce, 1)! < 6);
});

test("backtest: counts exits and re-centres where the price left", () => {
  assert.equal(backtestRecenters(path([0, 5, 11, 12, 30]), 10), 2); // 11 leaves ±10 of 0; 30 leaves ±10 of 11
  assert.equal(backtestRecenters(path([0, 5, 11, 12, 30]), 50), 0);
});

test("recenter cost: half the position at the pool fee plus gas", () => {
  assert.equal(recenterCostUsd(4000), 10.5);
});

test("table and recommendation: never narrow while fees lose to impermanent loss", () => {
  const recenters = new Map([[10, 18], [25, 7], [50, 2]]);
  const losing = widthTable({ feesPerDay: 10, ilPerDay: 12, currentHalfWidth: 50, spanDays: 14, costUsd: 11, recenters });
  assert.equal(recommendWidth(losing, 50).halfWidth, 50);
  const winning = widthTable({ feesPerDay: 13, ilPerDay: 5, currentHalfWidth: 50, spanDays: 14, costUsd: 11, recenters });
  const r10 = winning.find((r) => r.halfWidth === 10)!;
  assert.ok(Math.abs(r10.feesPerDay - 13 * 101 / 21) < 1e-9);
  assert.ok(Math.abs(r10.recenterPerDay - (18 / 14) * 11) < 1e-9);
  assert.notEqual(recommendWidth(winning, 50).halfWidth, 50);
});

test("recommendation: the 2026-11-04 table no longer jumps to ±10", () => {
  // The real table from 4 Nov: 20 days of bin path, 7.9 days of fee data, IL read low after a round trip.
  const recenters = new Map([[10, 32], [15, 22], [20, 8], [25, 11], [30, 5], [35, 3], [50, 3]]);
  const rows = widthTable({ feesPerDay: 9.11, ilPerDay: 1.81, currentHalfWidth: 50, spanDays: 20.02, costUsd: 10.95, recenters });
  assert.equal(recommendWidth(rows, 50).halfWidth, 10); // the old, uncapped behaviour
  const r = recommendWidth(rows, 50, { spanDays: 20.02, dataDays: 7.91 });
  assert.equal(r.halfWidth, 35);
  assert.match(r.reason, /provisional/);
  // With enough data, the recenter cap alone still rules out ±10 and ±15 (over 0.5 a day).
  assert.equal(recommendWidth(rows, 50, { spanDays: 20.02, dataDays: 30 }).halfWidth, 20);
});
