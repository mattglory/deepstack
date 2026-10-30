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
process.env.CAPITAL_FLOWS_PATH = join(tmpdir(), `deepstack-flows-test-${process.pid}.json`);
process.env.WALLET_MIGRATIONS_PATH = join(tmpdir(), `deepstack-migrations-test-${process.pid}.json`);
const { recordSample, adjustLpBasis, markPilotStart, METRICS_PATH } = await import("./metrics.js");

const sample = (lpValueY: number, mid = 400_000) => ({
  t: "2026-09-01T00:00:00Z", mid, ext: null,
  xBase: "100000", yBase: "400000000", lpValueY, portfolioY: 800, safe: true,
});
const dlmmSample = (t: string, dlmmValueY: number, mid = 400_000) => ({
  t, mid, ext: null,
  xBase: "100000", yBase: "400000000", lpValueY: 0, dlmmValueY, portfolioY: 800, safe: true,
});
const readBasis = () => JSON.parse(readFileSync(METRICS_PATH, "utf8")).lpBasis;
const readDlmmBasis = () => JSON.parse(readFileSync(METRICS_PATH, "utf8")).dlmmBasis;

beforeEach(() => { rmSync(METRICS_PATH, { force: true }); rmSync(process.env.CAPITAL_FLOWS_PATH!, { force: true }); rmSync(process.env.WALLET_MIGRATIONS_PATH!, { force: true }); });

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

test("pilot window: anchors + re-bases LP to zero-P&L at start, refuses to move once set", () => {
  recordSample("sbtc-stx", "SPX", 1800, sample(200)); // basis auto-inits at value 200 (yQty 100)
  recordSample("sbtc-stx", "SPX", 1800, sample(260)); // fees grew LP to 260; basis stays 100 (that's income)
  const r = markPilotStart();
  assert.equal(r.startedAt, "2026-09-01T00:00:00Z");
  const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  assert.equal(m.pilotBaseline.portfolioY, 800);
  // Re-anchored to the CURRENT 260 → P&L resets to ~0 at pilot start (yQty 130, not the old 100):
  assert.ok(Math.abs(m.lpBasis.yQty - 130) < 1e-6);
  assert.equal(m.lpBasis.t, "2026-09-01T00:00:00Z");
  // pilotBaseline gets its OWN fixed snapshot, matching the re-anchored lpBasis at this instant:
  assert.ok(Math.abs(m.pilotBaseline.lpBasis.yQty - 130) < 1e-6);
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

test("dlmmBasis: auto-initialises 50/50 at current mid, and growth does not re-init", () => {
  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-01T00:00:00Z", 200));
  let b = readDlmmBasis();
  assert.equal(b.yQty, 100);
  assert.equal(b.xQty, 100 / 400_000);
  assert.equal(b.t, "2026-09-01T00:00:00Z");
  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-01T00:30:00Z", 210)); // fees grew it
  b = readDlmmBasis();
  assert.equal(b.yQty, 100); // unchanged — growth is income, not a new deposit
  assert.equal(b.t, "2026-09-01T00:00:00Z");
});

test("dlmmBasis: RESETS when the position goes empty and is later reopened — a real capital event, not a recenter", () => {
  // Regression for the 2026-09-22 bug: a position withdrawn then reopened hours later was
  // still compared against its original pilot-start basis, fabricating a -60.8% APR on what
  // was actually a ~2h-old, roughly breakeven position.
  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-01T00:00:00Z", 150, 400_000)); // opened
  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-05T00:00:00Z", 0, 500_000)); // withdrawn (price moved a lot while out)
  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-06T00:00:00Z", 160, 500_000)); // reopened fresh
  const b = readDlmmBasis();
  assert.equal(b.t, "2026-09-06T00:00:00Z"); // anchored to the REOPEN, not the original Sep 1 deposit
  assert.equal(b.yQty, 80); // 50/50 of the fresh 160, at the fresh mid — not derived from the old basis at all
  assert.equal(b.xQty, 80 / 500_000);
});

test("pilotBaseline.dlmmBasis stays FIXED across a real withdraw-then-reopen, even though the top-level dlmmBasis correctly resets", () => {
  // Regression for the second half of the 2026-09-22 bug: fixing the top-level dlmmBasis
  // (so the DLMM P&L card is right) must NOT also move hodlNow()/pnl.ts's pilot-wide
  // "hold the original basket" comparison — that needs pilotBaseline.dlmmBasis specifically,
  // captured once and never touched again, independent of what happens to the live position.
  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-01T00:00:00Z", 150, 400_000)); // dlmmBasis auto-inits
  const r = markPilotStart();
  assert.equal(r.startedAt, "2026-09-01T00:00:00Z");
  let m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  assert.equal(m.pilotBaseline.dlmmBasis.yQty, 75); // snapshot taken at pilot start
  assert.equal(m.dlmmBasis.yQty, 75); // top-level starts out equal to the snapshot

  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-05T00:00:00Z", 0, 500_000)); // withdrawn
  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-06T00:00:00Z", 160, 500_000)); // reopened fresh
  m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  assert.equal(m.dlmmBasis.yQty, 80); // top-level correctly reset to the fresh deposit (DLMM card)
  assert.equal(m.pilotBaseline.dlmmBasis.yQty, 75); // pilot-wide snapshot UNCHANGED (Performance chart)
});

test("dlmmBasis: a same-cycle recenter (no intervening zero SAMPLE) does not reset the basis", () => {
  // decideRecenter's withdraw+immediate-readd happens between two recorded samples, so the
  // agent never observes an intervening zero — this is the case the reset must NOT fire on.
  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-01T00:00:00Z", 150, 400_000));
  recordSample("sbtc-usdcx", "SPX", 1800, dlmmSample("2026-09-01T00:30:00Z", 152, 410_000)); // recentered, still holding
  const b = readDlmmBasis();
  assert.equal(b.t, "2026-09-01T00:00:00Z"); // untouched
  assert.equal(b.yQty, 75);
});

// --- capital flows (owner deposits/withdrawals), 2026-10-22 ---
const { withdrawnStx, currentDrawdown, addCapitalFlow, loadCapitalFlows, addWalletMigration, loadWalletMigrations } = await import("./metrics.js");

test("withdrawnStx: sums withdrawals in (after, upTo], deposits net against them", () => {
  const flows = [
    { t: "2026-10-14T12:24:12Z", txid: "a", stx: -65 },
    { t: "2026-10-20T00:00:00Z", txid: "b", stx: 10 },
    { t: "2026-10-22T16:46:03Z", txid: "c", stx: -700 },
  ];
  assert.equal(withdrawnStx(flows, null, null), 755);
  assert.equal(withdrawnStx(flows, null, "2026-10-14T12:24:12Z"), 65); // inclusive at the end
  assert.equal(withdrawnStx(flows, "2026-10-14T12:24:12Z", null), 690); // exclusive at the start
  assert.equal(withdrawnStx([], null, null), 0);
});

test("currentDrawdown: an owner withdrawal is not a drawdown", () => {
  const s = (t: string, portfolioY: number) => ({ t, mid: 400_000, ext: null, xBase: "0", yBase: "0", lpValueY: 0, portfolioY, safe: true });
  recordSample("sbtc-stx", "SPX", 1800, s("2026-10-22T16:00:00Z", 3800));
  recordSample("sbtc-stx", "SPX", 1800, s("2026-10-22T17:00:00Z", 3100)); // after a 700 withdrawal
  assert.ok(currentDrawdown(3100, "2026-10-22T17:00:00Z") > 0.18, "without the flow it looks like an 18% drop");
  assert.equal(addCapitalFlow({ t: "2026-10-22T16:46:03Z", txid: "c", stx: -700 }), "added");
  assert.equal(addCapitalFlow({ t: "2026-10-22T16:46:03Z", txid: "c", stx: -700 }), "exists");
  assert.equal(loadCapitalFlows().length, 1);
  assert.equal(currentDrawdown(3100, "2026-10-22T17:00:00Z"), 0);
  // A real trading loss after the withdrawal still counts.
  assert.ok(Math.abs(currentDrawdown(3062, "2026-10-22T17:30:00Z") - 38 / 3800) < 1e-12);
});

test("capital flows live in their own file; metrics.json writes never drop them", () => {
  const s = (t: string) => ({ t, mid: 400_000, ext: null, xBase: "0", yBase: "0", lpValueY: 0, portfolioY: 1000, safe: true });
  recordSample("sbtc-stx", "SPX", 1800, s("2026-10-27T08:00:00Z"));
  addCapitalFlow({ t: "2026-10-27T08:47:21Z", txid: "d", stx: 3300 });
  // The flow went to its own file, not into metrics.json…
  assert.equal(JSON.parse(readFileSync(process.env.CAPITAL_FLOWS_PATH!, "utf8")).length, 1);
  assert.equal(JSON.parse(readFileSync(METRICS_PATH, "utf8")).capitalFlows, undefined);
  // …and the agent's next sample copies it across for the dashboard.
  recordSample("sbtc-stx", "SPX", 1800, s("2026-10-27T09:00:00Z"));
  assert.equal(JSON.parse(readFileSync(METRICS_PATH, "utf8")).capitalFlows[0].txid, "d");
});

test("capital flows recorded in metrics.json before the file existed are kept", () => {
  const s = (t: string) => ({ t, mid: 400_000, ext: null, xBase: "0", yBase: "0", lpValueY: 0, portfolioY: 1000, safe: true });
  recordSample("sbtc-stx", "SPX", 1800, s("2026-10-27T08:00:00Z"));
  const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  m.capitalFlows = [{ t: "2026-10-14T12:24:12Z", txid: "old", stx: -65 }];
  writeFileSync(METRICS_PATH, JSON.stringify(m));
  assert.equal(addCapitalFlow({ t: "2026-10-27T08:47:21Z", txid: "new", stx: 3300 }), "added");
  assert.deepEqual(loadCapitalFlows().map((f) => f.txid), ["old", "new"]);
  assert.equal(addCapitalFlow({ t: "2026-10-14T12:24:12Z", txid: "old", stx: -65 }), "exists");
});

test("wallet change: a recorded migration keeps the history; an unrecorded one starts fresh", () => {
  const s = (t: string) => ({ t, mid: 400_000, ext: null, xBase: "0", yBase: "0", lpValueY: 0, portfolioY: 1000, safe: true });
  recordSample("sbtc-stx", "SPOLD", 1800, s("2026-11-05T08:00:00Z"));
  recordSample("sbtc-stx", "SPOLD", 1800, s("2026-11-05T08:30:00Z"));
  const started = JSON.parse(readFileSync(METRICS_PATH, "utf8")).startedAt;

  // Unrecorded change: a different agent, so a fresh file.
  recordSample("sbtc-stx", "SPOTHER", 1800, s("2026-11-05T09:00:00Z"));
  assert.equal(JSON.parse(readFileSync(METRICS_PATH, "utf8")).samples.length, 1);

  // Back to the old wallet (fresh again), then a recorded rotation to the new one.
  rmSync(METRICS_PATH, { force: true });
  recordSample("sbtc-stx", "SPOLD", 1800, s("2026-11-05T08:00:00Z"));
  recordSample("sbtc-stx", "SPOLD", 1800, s("2026-11-05T08:30:00Z"));
  const mg = { t: "2026-11-05T09:10:00Z", from: "SPOLD", to: "SPNEW", txids: ["a", "b"] };
  assert.equal(addWalletMigration(mg), "added");
  assert.equal(addWalletMigration(mg), "exists");
  recordSample("sbtc-stx", "SPNEW", 1800, s("2026-11-05T10:00:00Z"));
  const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  assert.equal(m.wallet, "SPNEW");
  assert.equal(m.samples.length, 3);
  assert.equal(m.startedAt, started);
  assert.deepEqual(m.walletMigrations.map((x: { to: string }) => x.to), ["SPNEW"]);
  assert.deepEqual(loadWalletMigrations()[0].txids, ["a", "b"]);
});

test("dlmm fees: the latest on-chain figure is kept at the top; dropped when there is no position", () => {
  const s = (t: string, dlmmValueY: number, dlmmFeesUsdcx?: number) => ({ t, mid: 400_000, ext: null, xBase: "0", yBase: "0", lpValueY: 0, dlmmValueY, dlmmFeesUsdcx, portfolioY: 1000, safe: true });
  recordSample("sbtc-stx", "SPX", 1800, s("2026-10-30T10:00:00Z", 500, 12.5), { dlmmFeesSince: "2026-10-27T11:07:16Z" });
  let m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  assert.deepEqual(m.dlmmFees, { usdcx: 12.5, since: "2026-10-27T11:07:16Z", t: "2026-10-30T10:00:00Z" });
  assert.equal(m.samples[0].dlmmFeesUsdcx, 12.5);
  recordSample("sbtc-stx", "SPX", 1800, s("2026-10-30T10:30:00Z", 500)); // a read without a figure keeps the last
  assert.equal(JSON.parse(readFileSync(METRICS_PATH, "utf8")).dlmmFees.usdcx, 12.5);
  recordSample("sbtc-stx", "SPX", 1800, s("2026-10-30T11:00:00Z", 0)); // position withdrawn
  m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  assert.equal(m.dlmmFees, undefined);
});
