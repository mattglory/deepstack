// Unit tests for LP cost-basis tracking — the number behind "LP P&L (fees − IL)".
//
// The basis is LEG QUANTITIES, not an STX scalar: fees-net-of-IL compares the LP value
// against holding the deposited legs at today's mid, so the x-leg's price moves cancel
// out instead of masquerading as income.
//
// METRICS_PATH is captured at module load, so it's pointed at a temp file BEFORE the
// dynamic import (same pattern as publish.test.ts).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.METRICS_PATH = join(tmpdir(), `deepstack-metrics-test-${process.pid}.json`);
const { recordSample, adjustLpBasis, markPilotStart, METRICS_PATH } = await import("./metrics.js");

const sample = (lpValueY: number, mid = 400_000) => ({
  t: "2026-09-01T00:00:00Z", mid, ext: null,
  xBase: "100000", yBase: "400000000", lpValueY, portfolioY: 800, safe: true,
});
const readBasis = () => JSON.parse(readFileSync(METRICS_PATH, "utf8")).lpBasis;

beforeEach(() => rmSync(METRICS_PATH, { force: true }));

test("basis: auto-initialises 50/50 at current mid for a pre-tracking position", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(200));
  const b = readBasis();
  assert.equal(b.yQty, 100); // half the value in y
  assert.equal(b.xQty, 100 / 400_000); // half in x at the mid
  assert.equal(b.t, "2026-09-01T00:00:00Z");
  // Later growth must NOT re-initialise — that growth is the income.
  recordSample("sbtc-stx", "SPX", 1800, sample(210));
  assert.equal(readBasis().yQty, 100);
});

test("basis: migrates a legacy scalar lpBasisY into legs", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(200));
  const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  delete m.lpBasis;
  m.lpBasisY = 186.3; // legacy shape from the previous release
  writeFileSync(METRICS_PATH, JSON.stringify(m));
  recordSample("sbtc-stx", "SPX", 1800, sample(200));
  const b = readBasis();
  assert.ok(Math.abs(b.yQty - 93.15) < 1e-9);
  assert.equal(JSON.parse(readFileSync(METRICS_PATH, "utf8")).lpBasisY, undefined);
});

test("basis: never initialises while there is no LP position", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(0));
  assert.equal(readBasis(), undefined);
});

test("basis: add appends legs (keeping first-deposit time); withdraw burns both proportionally", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(200)); // init: x 0.00025, y 100
  adjustLpBasis({ kind: "add", xQty: 0.0001, yQty: 40, t: "2026-09-05T00:00:00Z" });
  let b = readBasis();
  assert.ok(Math.abs(b.xQty - 0.00035) < 1e-12);
  assert.equal(b.yQty, 140);
  assert.equal(b.t, "2026-09-01T00:00:00Z"); // observation window anchored at first deposit
  adjustLpBasis({ kind: "withdraw", fraction: 0.5 });
  b = readBasis();
  assert.equal(b.yQty, 70);
  adjustLpBasis({ kind: "withdraw", fraction: 1.7 }); // clamped: full exit
  assert.equal(readBasis().yQty, 0);
});

test("basis: adjust keeps the sample/basis PAIR consistent — no fake in-flight loss", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(200)); // pre-action sample: LP value 200
  adjustLpBasis({ kind: "add", xQty: 0.0001, yQty: 40, t: "2026-09-05T00:00:00Z" });
  let m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  // Sample bumped by the add's value (2×yQty), matching the basis growth exactly:
  assert.equal(m.samples[m.samples.length - 1].lpValueY, 280);
  const basisVal = m.lpBasis.xQty * 400_000 + m.lpBasis.yQty; // = 100+40 + (0.00025+0.0001)*mid
  assert.ok(Math.abs(m.samples[m.samples.length - 1].lpValueY - basisVal) < 1e-9);
  adjustLpBasis({ kind: "withdraw", fraction: 0.5 });
  m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  assert.equal(m.samples[m.samples.length - 1].lpValueY, 140);
});

test("fees-net-of-IL: a pure price move nets to ~zero against the leg benchmark", () => {
  // Init 200 STX position at mid 400k → legs x=0.00025, y=100.
  recordSample("sbtc-stx", "SPX", 1800, sample(200, 400_000));
  const b = readBasis();
  // Mid rises 10%: HODL-legs = 0.00025*440000 + 100 = 210. A no-fee LP is worth
  // ~2*sqrt(price ratio) ≈ 209.76 → net ≈ −0.24 (pure IL), NOT +10 of price gain.
  const hodlLegs = b.xQty * 440_000 + b.yQty;
  assert.equal(hodlLegs, 210);
  const lpNoFee = 200 * Math.sqrt(440_000 / 400_000);
  assert.ok(lpNoFee - hodlLegs < 0 && lpNoFee - hodlLegs > -0.3); // small negative = IL only
});

test("basis: adjust is a no-op without a metrics file (never throws)", () => {
  adjustLpBasis({ kind: "add", xQty: 1, yQty: 1, t: "2026-09-01T00:00:00Z" });
  assert.throws(() => readFileSync(METRICS_PATH));
});

test("pilot window: anchors at the latest sample, refuses to move once set", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(200));
  const r = markPilotStart();
  assert.equal(r.startedAt, "2026-09-01T00:00:00Z");
  const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  assert.equal(m.pilotBaseline.portfolioY, 800);
  assert.equal(m.pilotBaseline.xBase, "100000");
  assert.throws(() => markPilotStart(), /already started/); // evidence windows don't move
});

test("pilot window: refuses with no telemetry", () => {
  assert.throws(() => markPilotStart(), /no telemetry/);
});

test("basis: survives the sample-cap slicing", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(200));
  const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  m.samples = Array(2000).fill(m.samples[0]);
  writeFileSync(METRICS_PATH, JSON.stringify(m));
  recordSample("sbtc-stx", "SPX", 1800, sample(201));
  assert.equal(readBasis().yQty, 100);
});
