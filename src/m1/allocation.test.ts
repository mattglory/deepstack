// Unit tests for regime-aware defensive allocation — the capital-preservation reflex.
//
// The load-bearing properties: (1) OFF by default it's exactly static 50/50 (the pilot must
// not change by accident); (2) drawdown or high vol forces defensive; (3) the AI can only
// tighten risk, never loosen it; (4) every output is bounded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAllocation, defaultAllocationParams, type AllocationParams } from "./allocation.js";

const P = (over: Partial<AllocationParams> = {}): AllocationParams => ({
  enabled: true,
  neutralYFraction: 0.5,
  defensiveYFraction: 0.35,
  fullLpFraction: 0.3,
  volElevated: 0.04,
  volDefensive: 0.06,
  drawdownDefensive: 0.08,
  ...over,
});

test("allocation: disabled → exactly static neutral 50/50, full LP (pilot safety)", () => {
  const d = decideAllocation({ sigmaDaily: 0.5, drawdownFrac: 0.9 }, P({ enabled: false }));
  assert.equal(d.regime, "calm");
  assert.equal(d.targetYFraction, 0.5);
  assert.equal(d.targetLpFraction, 0.3); // even in a crash, OFF means unchanged
});

test("allocation: calm regime → neutral, full LP", () => {
  const d = decideAllocation({ sigmaDaily: 0.02, drawdownFrac: 0 }, P());
  assert.equal(d.regime, "calm");
  assert.equal(d.targetYFraction, 0.5);
  assert.equal(d.targetLpFraction, 0.3);
});

test("allocation: elevated vol → neutral inventory but LP halved (cut IL exposure)", () => {
  const d = decideAllocation({ sigmaDaily: 0.05, drawdownFrac: 0 }, P());
  assert.equal(d.regime, "elevated");
  assert.equal(d.targetYFraction, 0.5);
  assert.equal(d.targetLpFraction, 0.15);
});

test("allocation: high vol → defensive skew to safe asset, LP off", () => {
  const d = decideAllocation({ sigmaDaily: 0.07, drawdownFrac: 0 }, P());
  assert.equal(d.regime, "defensive");
  assert.equal(d.targetYFraction, 0.35); // skewed toward the safe (x) asset
  assert.equal(d.targetLpFraction, 0);
});

test("allocation: drawdown forces defensive even in low vol (capital preservation)", () => {
  const d = decideAllocation({ sigmaDaily: 0.01, drawdownFrac: 0.10 }, P());
  assert.equal(d.regime, "defensive");
  assert.equal(d.targetLpFraction, 0);
  assert.match(d.reason, /drawdown/);
});

test("allocation: AI can only TIGHTEN risk, never loosen it", () => {
  // Measured calm, AI says defensive → we go defensive (advice may make us more cautious).
  const up = decideAllocation({ sigmaDaily: 0.01, drawdownFrac: 0 }, P(), "defensive");
  assert.equal(up.regime, "defensive");
  // Measured defensive, AI says calm → we STAY defensive (advice can't loosen risk).
  const down = decideAllocation({ sigmaDaily: 0.07, drawdownFrac: 0 }, P(), "calm");
  assert.equal(down.regime, "defensive");
});

test("allocation: outputs stay bounded for absurd params", () => {
  const d = decideAllocation({ sigmaDaily: 99, drawdownFrac: 5 }, P({ defensiveYFraction: 9 }));
  assert.ok(d.targetYFraction >= 0 && d.targetYFraction <= 1);
  assert.ok(d.targetLpFraction >= 0);
});

test("allocation: default params are OFF unless ALLOCATION_MODE=adaptive", () => {
  delete process.env.ALLOCATION_MODE;
  assert.equal(defaultAllocationParams().enabled, false);
  process.env.ALLOCATION_MODE = "adaptive";
  assert.equal(defaultAllocationParams().enabled, true);
  delete process.env.ALLOCATION_MODE;
});
