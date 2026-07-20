// Tests for the Route C paper-hedge P&L model — the number that will decide, with 30 days
// of evidence, whether real hedged capture is worth doing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { paperPnl } from "./hedged-paper.js";

test("paper: a fat edge clears all hedge costs", () => {
  // 8 STX edge on a 1000 STX notional, benign funding, 50bps unwind
  const r = paperPnl(8, 1000, 0.00002, { poolFeeBps: 50, expectedHoldHours: 12 });
  // perp 1000*0.00055*2 = 1.1; funding 1000*0.00002*1.5 = 0.03; unwind 1000*0.005 = 5
  assert.ok(Math.abs(r.perpFeeStx - 1.1) < 1e-6);
  assert.ok(Math.abs(r.unwindFeeStx - 5) < 1e-6);
  assert.ok(r.netStx > 0 && r.clears);
});

test("paper: a thin edge is eaten by the unwind pool fee — the usual case", () => {
  // 1 STX edge, 1000 notional: the 5 STX unwind fee alone sinks it
  const r = paperPnl(1, 1000, 0.00002, { poolFeeBps: 50 });
  assert.ok(r.netStx < 0 && !r.clears);
});

test("paper: high positive funding turns a marginal trade negative", () => {
  const benign = paperPnl(6, 1000, 0.00002, { poolFeeBps: 50 });
  const stressed = paperPnl(6, 1000, 0.01, { poolFeeBps: 50, expectedHoldHours: 24 }); // 1% per 8h, held a day
  assert.ok(stressed.netStx < benign.netStx);
  // funding at 1%/8h over 24h = 3 periods = 30 STX on 1000 notional — dominates
  assert.ok(Math.abs(stressed.fundingStx - 30) < 1e-6);
  assert.equal(stressed.clears, false);
});

test("paper: components sum to net (no hidden terms)", () => {
  const r = paperPnl(8, 1000, 0.00002, { poolFeeBps: 50 });
  assert.ok(Math.abs(r.netStx - (r.edgeStx - r.perpFeeStx - r.fundingStx - r.unwindFeeStx)) < 1e-9);
});
