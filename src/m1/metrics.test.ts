// Unit tests for LP cost-basis tracking — the number behind "LP P&L (fees − IL)".
//
// METRICS_PATH is captured at module load, so it's pointed at a temp file BEFORE the
// dynamic import (same pattern as publish.test.ts) — otherwise the suite would write
// into the real dashboard/metrics.json.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.METRICS_PATH = join(tmpdir(), `deepstack-metrics-test-${process.pid}.json`);
const { recordSample, adjustLpBasis, METRICS_PATH } = await import("./metrics.js");

const sample = (lpValueY: number) => ({
  t: "2026-09-01T00:00:00Z", mid: 400_000, ext: null,
  xBase: "100000", yBase: "400000000", lpValueY, portfolioY: 800, safe: true,
});
const readBasis = () => JSON.parse(readFileSync(METRICS_PATH, "utf8")).lpBasisY;

beforeEach(() => rmSync(METRICS_PATH, { force: true }));

test("basis: auto-initialises at current value for a pre-tracking position", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(186.3));
  assert.equal(readBasis(), 186.3);
  // A later, larger LP value must NOT re-initialise — that growth is the income.
  recordSample("sbtc-stx", "SPX", 1800, sample(190.0));
  assert.equal(readBasis(), 186.3);
});

test("basis: never initialises while there is no LP position", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(0));
  assert.equal(readBasis(), undefined);
});

test("basis: add increments by the deposited value; withdraw burns proportionally", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(100));
  adjustLpBasis({ kind: "add", addedValueY: 50 });
  assert.equal(readBasis(), 150);
  adjustLpBasis({ kind: "withdraw", fraction: 0.4 }); // burn 40% of the position
  assert.equal(readBasis(), 90);
  adjustLpBasis({ kind: "withdraw", fraction: 1.7 }); // clamped: full exit, basis 0
  assert.equal(readBasis(), 0);
});

test("basis: adjust is a no-op without a metrics file (never throws)", () => {
  adjustLpBasis({ kind: "add", addedValueY: 50 }); // no file yet — must not create or crash
  assert.throws(() => readFileSync(METRICS_PATH));
});

test("basis: survives the sample-cap slicing", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(100));
  const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  m.samples = Array(2000).fill(m.samples[0]); // at the cap
  writeFileSync(METRICS_PATH, JSON.stringify(m));
  recordSample("sbtc-stx", "SPX", 1800, sample(101)); // forces a slice
  assert.equal(readBasis(), 100);
});
