// Unit tests for the deterministic decision core + slippage math + safety gate.
// These are the pure, I/O-free functions — the pieces that must be provably correct
// because real capital rides on them. Run: npm test
//
// Uses Node's built-in test runner (node --test), no extra dependencies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { exceedsPoolShare } from "./agent.js";

test("pool-share cap: bounds our share AFTER the add; refuses on unreadable pool", () => {
  // 1,000 in a 100,000 pool = 1% — a 500 add → 1500/100500 ≈ 1.49% < 2% cap → allowed
  assert.equal(exceedsPoolShare(1000, 500, 100_000, 200), false);
  // same add into a 40,000 pool → 1500/40500 ≈ 3.7% > 2% → blocked
  assert.equal(exceedsPoolShare(1000, 500, 40_000, 200), true);
  // shrinking-pool scenario: position static, pool halves → next add blocked
  assert.equal(exceedsPoolShare(1000, 100, 50_000, 200), true);
  // unreadable pool value → refuse to grow (fail closed)
  assert.equal(exceedsPoolShare(1000, 100, 0, 200), true);
});
import { decide, decideLp, defaultParams, bandBpsFromVol, type AgentParams } from "./agent.js";
import { minusSlippage, plusSlippage } from "./quotes.js";
import { assessSafety, defaultSafetyParams } from "./safety.js";

// sBTC-STX-like decimals for readability: x=sBTC (8dp), y=STX (6dp), mid≈350k
const XD = 8;
const YD = 6;
const MID = 350_000;
const P = (): AgentParams => ({ ...defaultParams(), targetLpFraction: 0 });

// helpers to build inventories at a given value split (value measured in y)
const xBaseForValueY = (valY: number) => BigInt(Math.round((valY / MID) * 10 ** XD));
const yBaseForValueY = (valY: number) => BigInt(Math.round(valY * 10 ** YD));

test("slippage: floor for received, ceiling for sent, at 100 bps", () => {
  assert.equal(minusSlippage(1_000_000n, 100), 990_000n);
  assert.equal(plusSlippage(1_000_000n, 100), 1_010_000n);
  assert.equal(minusSlippage(1_000_000n, 0), 1_000_000n); // 0 bps = identity
});

test("decide: balanced inventory within band → HOLD", () => {
  const d = decide({ xBase: xBaseForValueY(50), yBase: yBaseForValueY(50) }, MID, XD, YD, P());
  assert.equal(d.action, "none");
  assert.ok(Math.abs(d.metrics.drift) <= 0.05);
});

test("decide: excess y (too much STX) → swap-y-for-x (buy sBTC)", () => {
  // 80% value in y, 20% in x → well outside the 5% band
  const d = decide({ xBase: xBaseForValueY(20), yBase: yBaseForValueY(80) }, MID, XD, YD, P());
  assert.equal(d.action, "swap-y-for-x");
  assert.ok(d.amountBase > 0n);
});

test("decide: excess x (too much sBTC) → swap-x-for-y (sell sBTC)", () => {
  const d = decide({ xBase: xBaseForValueY(80), yBase: yBaseForValueY(20) }, MID, XD, YD, P());
  assert.equal(d.action, "swap-x-for-y");
  assert.ok(d.amountBase > 0n);
});

test("decide: swap size is clamped to the hard cap", () => {
  const params = { ...P(), maxSwapYBase: 1_000_000n }; // cap 1 STX
  // hugely y-heavy inventory would want to move far more than 1 STX
  const d = decide({ xBase: xBaseForValueY(1), yBase: yBaseForValueY(999) }, MID, XD, YD, params);
  assert.equal(d.action, "swap-y-for-x");
  assert.equal(d.amountBase, 1_000_000n); // clamped exactly to the cap
});

test("decide: empty inventory → HOLD (no divide-by-zero)", () => {
  const d = decide({ xBase: 0n, yBase: 0n }, MID, XD, YD, P());
  assert.equal(d.action, "none");
  assert.equal(d.metrics.totalY, 0);
});

test("decide: direction flips around the target as drift crosses zero", () => {
  const justOverY = decide({ xBase: xBaseForValueY(40), yBase: yBaseForValueY(60) }, MID, XD, YD, P());
  const justOverX = decide({ xBase: xBaseForValueY(60), yBase: yBaseForValueY(40) }, MID, XD, YD, P());
  assert.equal(justOverY.action, "swap-y-for-x");
  assert.equal(justOverX.action, "swap-x-for-y");
});

test("decideLp: disabled when targetLpFraction = 0", () => {
  const d = decideLp(100, 0n, 0, xBaseForValueY(50), yBaseForValueY(50), MID, XD, YD, P());
  assert.equal(d.action, "none");
});

test("decideLp: under target with inventory → add-liquidity, gap-sized (not all-in)", () => {
  const params = { ...defaultParams(), targetLpFraction: 0.3, maxAddXBase: 10n ** 12n };
  // portfolio 100 (y), 0 LP, plenty of free x and y
  const d = decideLp(100, 0n, 0, xBaseForValueY(50), yBaseForValueY(50), MID, XD, YD, params);
  assert.equal(d.action, "add-liquidity");
  // gap = 30 (y-value); half in x ≈ 15 y-value worth of x → must be < the full 50 x-value available
  const xValueAdded = (Number(d.xBase) / 10 ** XD) * MID;
  assert.ok(xValueAdded > 0 && xValueAdded < 50, `expected gap-sized add, got ${xValueAdded}`);
});

test("decideLp: over target → withdraw-liquidity", () => {
  const params = { ...defaultParams(), targetLpFraction: 0.2 };
  // LP worth 80 of a 100 portfolio, way over the 20% target
  const d = decideLp(100, 1_000_000n, 80, 0n, 0n, MID, XD, YD, params);
  assert.equal(d.action, "withdraw-liquidity");
  assert.ok(d.lpBase > 0n && d.lpBase <= 1_000_000n);
});

test("bandBpsFromVol: the df/d(ln m) = -1/4 sensitivity the formula rests on is real", () => {
  // Verify numerically rather than trusting the algebra in the docstring: at a 50/50
  // split, a small mid move should shift the y-fraction by about a quarter of it.
  const yFrac = (xBase: bigint, yBase: bigint, m: number) => {
    const xv = (Number(xBase) / 10 ** XD) * m, yv = Number(yBase) / 10 ** YD;
    return yv / (yv + xv);
  };
  const x = xBaseForValueY(50), y = yBaseForValueY(50); // balanced at MID
  const r = 0.001; // small log-return
  const drift = yFrac(x, y, MID * Math.exp(r)) - yFrac(x, y, MID);
  assert.ok(Math.abs(drift - -r / 4) < 1e-6, `expected ~${-r / 4}, got ${drift}`);
});

test("bandBpsFromVol: reproduces the AI layer's own calm/volatile mapping", () => {
  // The calibration claim in the docstring: 6 sigmas ≈ 300bps calm, 900bps volatile.
  assert.equal(bandBpsFromVol(0.02), 300); // 6 * 2% / 4 = 3%
  assert.equal(bandBpsFromVol(0.06), 900); // 6 * 6% / 4 = 9%
});

test("bandBpsFromVol: band widens with volatility", () => {
  assert.ok(bandBpsFromVol(0.05) > bandBpsFromVol(0.03));
});

test("bandBpsFromVol: clamped at both ends — a risk control must not switch itself off", () => {
  assert.equal(bandBpsFromVol(0.0001), 300); // dead-calm cannot collapse the band to zero
  assert.equal(bandBpsFromVol(10), 900); // a vol blow-up cannot widen it without limit
});

test("bandBpsFromVol: degenerate vol falls back to the floor, never NaN", () => {
  assert.equal(bandBpsFromVol(0), 300);
  assert.equal(bandBpsFromVol(-1), 300);
  assert.equal(bandBpsFromVol(NaN), 300);
});

test("bandBpsFromVol: honours custom risk appetite and clamps", () => {
  assert.equal(bandBpsFromVol(0.04, 6, 100, 2000), 600); // 6 * 4% / 4 = 6%
  assert.equal(bandBpsFromVol(0.04, 12, 100, 2000), 1200); // twice the appetite, twice the band
});

test("safety: pool mid near external → safe", () => {
  const r = assessSafety(
    { poolMid: 350_000, externalMid: 351_000, poolActive: true, portfolioStx: 100, sessionStartStx: 100 },
    defaultSafetyParams(),
  );
  assert.equal(r.safe, true);
  assert.equal(r.reasons.length, 0);
});

test("safety: divergence beyond band → halt (manipulation guard)", () => {
  const r = assessSafety(
    { poolMid: 350_000, externalMid: 300_000, poolActive: true, portfolioStx: 100, sessionStartStx: 100 },
    defaultSafetyParams(),
  );
  assert.equal(r.safe, false);
  assert.ok(r.reasons.some((x) => x.includes("divergence")));
});

test("safety: paused pool → halt", () => {
  const r = assessSafety(
    { poolMid: 350_000, externalMid: 350_000, poolActive: false, portfolioStx: 100, sessionStartStx: 100 },
    defaultSafetyParams(),
  );
  assert.equal(r.safe, false);
  assert.ok(r.reasons.some((x) => x.includes("paused")));
});

test("safety: missing external reference → fail closed", () => {
  const r = assessSafety(
    { poolMid: 350_000, externalMid: null, poolActive: true, portfolioStx: 100, sessionStartStx: 100 },
    defaultSafetyParams(),
  );
  assert.equal(r.safe, false);
  assert.ok(r.reasons.some((x) => x.includes("no external")));
});

test("safety: drawdown beyond limit → halt", () => {
  const r = assessSafety(
    { poolMid: 350_000, externalMid: 350_000, poolActive: true, portfolioStx: 80, sessionStartStx: 100 },
    defaultSafetyParams(), // 15% default limit; 20% drop trips it
  );
  assert.equal(r.safe, false);
  assert.ok(r.reasons.some((x) => x.includes("drawdown")));
});
