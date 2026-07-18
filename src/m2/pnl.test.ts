// Unit tests for P&L attribution — the numbers destined for the pilot results post.
//
// The one that matters most: vs-HODL must attribute correctly with a moving mid, because
// that figure is the pilot's headline honest metric.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, renderMarkdown, type TickRecord, type MetricsSampleLite } from "./pnl.js";

// 1 sBTC-sat = 1e-8, STX = 1e6 µSTX. Start: 0.001 sBTC + 400 STX at mid 400k → 800 STX.
const s = (t: string, mid: number, portfolioY: number): MetricsSampleLite => ({
  t, mid, portfolioY, xBase: "100000", yBase: "400000000",
});
const tick = (t: string, over: Partial<TickRecord> = {}): TickRecord => ({
  t, mode: "live", safe: true, rebalance: { action: "none", reason: "within band" }, ...over,
});

test("pnl: vs-HODL attribution with a moving mid", () => {
  // Mid 400k → 500k. HODL end = 0.001*500000 + 400 = 900. Agent ends at 909 → +1% vs HODL.
  const samples = [s("2026-09-01T00:00:00Z", 400_000, 800), s("2026-09-30T00:00:00Z", 500_000, 909)];
  const r = buildReport([], samples, 1800);
  assert.ok(r.pnl);
  assert.equal(r.pnl.hodlEndY, 900);
  assert.equal(r.pnl.vsHodlPct, 1);
  assert.equal(r.pnl.totalPct, +((109 / 800) * 100).toFixed(3));
});

test("pnl: uptime against declared cadence; ad-hoc runs stay honest (null)", () => {
  const samples = [s("2026-09-01T00:00:00Z", 4e5, 800), s("2026-09-01T01:00:00Z", 4e5, 800)];
  const r = buildReport([], samples, 1800); // 1h window @30min → 3 expected, 2 beats
  assert.equal(r.uptime.expected, 3);
  assert.equal(r.uptime.pct, +((2 / 3) * 100).toFixed(1));
  assert.equal(buildReport([], samples, 0).uptime.pct, null); // no cadence declared
});

test("pnl: decision + tx census counts what happened, halts included", () => {
  const entries: TickRecord[] = [
    tick("2026-09-01T00:00:00Z"),
    tick("2026-09-01T00:30:00Z", { action: "swap-x-for-y", txid: "aa", status: "success", rebalance: { action: "swap-x-for-y" } }),
    tick("2026-09-01T01:00:00Z", { action: "add-liquidity", txid: "bb", status: "success" }),
    tick("2026-09-01T01:30:00Z", { safe: false, haltReasons: ["divergence"] }),
    { t: "2026-09-01T02:00:00Z", type: "cycle-error" },
    { t: "2026-09-01T02:10:00Z", type: "tune" },
  ];
  const r = buildReport(entries, [], 1800);
  assert.equal(r.decisions.ticks, 4);
  assert.equal(r.decisions.rebalances, 1);
  assert.equal(r.decisions.lpAdds, 1);
  assert.equal(r.decisions.safetyHalts, 1);
  assert.equal(r.decisions.cycleErrors, 1);
  assert.equal(r.txs.broadcasts, 2);
  assert.equal(r.txs.feesStx, 0.1);
});

test("pnl: arb edge sums observed opportunities; window filter applies", () => {
  const entries: TickRecord[] = [
    tick("2026-09-01T00:00:00Z", { arb: { netEdgeY: 1.5 } }),
    tick("2026-09-02T00:00:00Z", { arb: { netEdgeY: 2.5 } }),
    tick("2026-08-31T00:00:00Z", { arb: { netEdgeY: 99 } }), // outside window
  ];
  const r = buildReport(entries, [], 1800, "2026-09-01");
  assert.equal(r.arb.opportunities, 2);
  assert.equal(r.arb.totalEdgeY, 4);
  assert.equal(r.arb.maxEdgeY, 2.5);
});

test("pnl: markdown renders without a P&L section when telemetry is thin", () => {
  const md = renderMarkdown(buildReport([tick("2026-09-01T00:00:00Z")], [], 1800));
  assert.match(md, /not enough telemetry/);
  assert.match(md, /Holds/);
});
