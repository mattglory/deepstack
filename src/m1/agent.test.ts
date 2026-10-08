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
import { decide, decideLp, defaultParams, bandBpsFromVol, dlmmLiveGate, xykLiveGate, flashLiveGate, useFlashRoute, FLASH_RECEIVER_ADDS_CAPACITY, nextDlmmCounters, nextFlashCounters, type AgentParams } from "./agent.js";
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

test("decide: swap size is clamped to the hard cap, but uncappedAmountBase keeps the real deficit", () => {
  const params = { ...P(), maxSwapYBase: 1_000_000n }; // cap 1 STX
  // hugely y-heavy inventory would want to move far more than 1 STX
  const d = decide({ xBase: xBaseForValueY(1), yBase: yBaseForValueY(999) }, MID, XD, YD, params);
  assert.equal(d.action, "swap-y-for-x");
  assert.equal(d.amountBase, 1_000_000n); // clamped exactly to the cap
  // Regression test for a dead-code bug found 2026-10-02: agent-cli.ts's act() had a
  // `d.amountBase > params.maxSwapYBase` refusal check that could never fire, because
  // amountBase was always already clamped before act() ever saw it. uncappedAmountBase is
  // what exposes the real pre-clamp need, which the autonomous flash-rebalance path uses.
  assert.ok(d.uncappedAmountBase > d.amountBase, "uncappedAmountBase must exceed the clamped amountBase when the cap actually bound");
});

test("decide: under the cap, uncappedAmountBase equals the (unclamped) amountBase exactly", () => {
  const d = decide({ xBase: xBaseForValueY(20), yBase: yBaseForValueY(80) }, MID, XD, YD, P());
  assert.equal(d.action, "swap-y-for-x");
  assert.equal(d.uncappedAmountBase, d.amountBase);
});

test("decide: within band, both amountBase and uncappedAmountBase are 0", () => {
  const d = decide({ xBase: xBaseForValueY(50), yBase: yBaseForValueY(50) }, MID, XD, YD, P());
  assert.equal(d.amountBase, 0n);
  assert.equal(d.uncappedAmountBase, 0n);
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

// dlmmLiveGate: regression coverage for the Sep 2026 external-review finding — DLMM
// recenters used to check only the kill switch and nonce safety before broadcasting, not
// the same oracle-divergence/drawdown/pool-paused gate (safety.safe) that has always
// covered XYK trades. A live cycle under normal market conditions can't distinguish "the
// gate works" from "the gate is missing and nothing unsafe happened to trigger it" — only
// a direct test with safe: false proves the fix.
const gateBase = {
  dlmmLiveFlag: true,
  live: true,
  circuitOk: true,
  safe: true,
  dlmmFailStreak: 0,
  dlmmFailStreakLimit: 2,
  dlmmRecenters: 0,
  maxTrades: 10,
};

test("dlmmLiveGate: all conditions met → live", () => {
  assert.equal(dlmmLiveGate(gateBase), true);
});

test("dlmmLiveGate: unsafe (oracle divergence / drawdown / pool-paused) blocks the broadcast even when everything else is green — the exact gap the fix closes", () => {
  assert.equal(dlmmLiveGate({ ...gateBase, safe: false }), false);
});

test("dlmmLiveGate: DLMM_LIVE flag off blocks it", () => {
  assert.equal(dlmmLiveGate({ ...gateBase, dlmmLiveFlag: false }), false);
});

test("dlmmLiveGate: agent not live (observe mode) blocks it", () => {
  assert.equal(dlmmLiveGate({ ...gateBase, live: false }), false);
});

test("dlmmLiveGate: circuit breaker open blocks it", () => {
  assert.equal(dlmmLiveGate({ ...gateBase, circuitOk: false }), false);
});

test("dlmmLiveGate: fail streak at/over the limit blocks it", () => {
  assert.equal(dlmmLiveGate({ ...gateBase, dlmmFailStreak: 2, dlmmFailStreakLimit: 2 }), false);
});

test("dlmmLiveGate: per-run recenter budget exhausted blocks it", () => {
  assert.equal(dlmmLiveGate({ ...gateBase, dlmmRecenters: 10, maxTrades: 10 }), false);
});

// xykLiveGate: the XYK analogue, extracted from an inline `live && circuitOk && trades <
// f.maxTrades` in agent-cli.ts (external review, issue #7 — orchestration gating untested).
const xykGateBase = { live: true, circuitOk: true, trades: 0, maxTrades: 1 };

test("xykLiveGate: all conditions met → live", () => {
  assert.equal(xykLiveGate(xykGateBase), true);
});

test("xykLiveGate: observe mode (not live) blocks it", () => {
  assert.equal(xykLiveGate({ ...xykGateBase, live: false }), false);
});

test("xykLiveGate: circuit breaker open blocks it", () => {
  assert.equal(xykLiveGate({ ...xykGateBase, circuitOk: false }), false);
});

test("xykLiveGate: lifetime trade ceiling reached blocks it", () => {
  assert.equal(xykLiveGate({ ...xykGateBase, trades: 1, maxTrades: 1 }), false);
});

// nextDlmmCounters: the state machine behind dlmmFailStreak/dlmmRecenters persistence
// (external review, issue #6 — restart behaviour; issue #7 — this was an untested inline
// transition split across two call sites in agent-cli.ts before being unified here).
test("nextDlmmCounters: a successful execute resets the fail streak AND bumps recenters", () => {
  assert.deepEqual(
    nextDlmmCounters({ failStreak: 1, recenters: 4 }, { executed: true, attempted: true }),
    { failStreak: 0, recenters: 5 },
  );
});

test("nextDlmmCounters: a real failed attempt bumps the fail streak, leaves recenters alone", () => {
  assert.deepEqual(
    nextDlmmCounters({ failStreak: 0, recenters: 4 }, { executed: false, attempted: true }),
    { failStreak: 1, recenters: 4 },
  );
});

test("nextDlmmCounters: not attempted (hold, or a deliberate skip) changes nothing", () => {
  assert.deepEqual(
    nextDlmmCounters({ failStreak: 1, recenters: 4 }, { executed: false, attempted: false }),
    { failStreak: 1, recenters: 4 },
  );
});

test("nextDlmmCounters: a thrown add counts as attempted even though recenterOnce never returned a result", () => {
  // agent-cli.ts's catch block: dlmmLive was true and it threw — treated as executed: false,
  // attempted: true, same as a normal cycle's failed-but-didn't-throw outcome.
  assert.deepEqual(
    nextDlmmCounters({ failStreak: 1, recenters: 4 }, { executed: false, attempted: true }),
    { failStreak: 2, recenters: 4 },
  );
});

// flashLiveGate: the autonomous flash-rebalance gate, same family and same reasoning as
// dlmmLiveGate/xykLiveGate above — a composed boolean inline is easy to get subtly wrong, and
// a passing live cycle under normal conditions would not catch a dropped term (in particular,
// safe: false MUST block it exactly like it does for DLMM; this is a real-money broadcast,
// not a lesser one just because it uses a different mechanism than a plain swap).
const flashGateBase = {
  flashLiveFlag: true,
  live: true,
  circuitOk: true,
  safe: true,
  flashFailStreak: 0,
  flashFailStreakLimit: 2,
  flashAttempts: 0,
  maxTrades: 10,
};

test("flashLiveGate: all conditions met → live", () => {
  assert.equal(flashLiveGate(flashGateBase), true);
});

test("flashLiveGate: FLASH_LIVE flag off blocks it", () => {
  assert.equal(flashLiveGate({ ...flashGateBase, flashLiveFlag: false }), false);
});

test("flashLiveGate: agent not live (observe mode) blocks it", () => {
  assert.equal(flashLiveGate({ ...flashGateBase, live: false }), false);
});

test("flashLiveGate: circuit breaker open blocks it", () => {
  assert.equal(flashLiveGate({ ...flashGateBase, circuitOk: false }), false);
});

test("flashLiveGate: unsafe (oracle divergence / drawdown / pool-paused) blocks it — same gate DLMM's fix proved, applied here from the start", () => {
  assert.equal(flashLiveGate({ ...flashGateBase, safe: false }), false);
});

test("flashLiveGate: fail streak at/over the limit blocks it", () => {
  assert.equal(flashLiveGate({ ...flashGateBase, flashFailStreak: 2, flashFailStreakLimit: 2 }), false);
});

test("flashLiveGate: lifetime attempt budget exhausted blocks it", () => {
  assert.equal(flashLiveGate({ ...flashGateBase, flashAttempts: 10, maxTrades: 10 }), false);
});

// nextFlashCounters: identical transition rules to nextDlmmCounters, same reason — a
// flash-rebalance attempt and a DLMM recenter attempt are the same shape of gated-broadcast
// event (lands, fails, or is never tried this cycle).
test("nextFlashCounters: a successful execute resets the fail streak AND bumps attempts", () => {
  assert.deepEqual(
    nextFlashCounters({ failStreak: 1, attempts: 4 }, { executed: true, attempted: true }),
    { failStreak: 0, attempts: 5 },
  );
});

test("nextFlashCounters: a real failed attempt bumps the fail streak, leaves attempts alone", () => {
  assert.deepEqual(
    nextFlashCounters({ failStreak: 0, attempts: 4 }, { executed: false, attempted: true }),
    { failStreak: 1, attempts: 4 },
  );
});

test("nextFlashCounters: not attempted (skipped, not worthwhile) changes nothing", () => {
  assert.deepEqual(
    nextFlashCounters({ failStreak: 1, attempts: 4 }, { executed: false, attempted: false }),
    { failStreak: 1, attempts: 4 },
  );
});

test("nextFlashCounters: a thrown attempt still counts as attempted", () => {
  assert.deepEqual(
    nextFlashCounters({ failStreak: 1, attempts: 4 }, { executed: false, attempted: true }),
    { failStreak: 2, attempts: 4 },
  );
});

test("useFlashRoute: never with the current receiver, which repays from our own STX (2026-10-08)", () => {
  assert.equal(FLASH_RECEIVER_ADDS_CAPACITY, false);
  assert.equal(useFlashRoute({ overCap: true, action: "swap-y-for-x", receiverAddsCapacity: FLASH_RECEIVER_ADDS_CAPACITY }), false);
});

test("useFlashRoute: only over cap, only buying sBTC, only with a capacity-adding receiver", () => {
  assert.equal(useFlashRoute({ overCap: true, action: "swap-y-for-x", receiverAddsCapacity: true }), true);
  assert.equal(useFlashRoute({ overCap: false, action: "swap-y-for-x", receiverAddsCapacity: true }), false);
  assert.equal(useFlashRoute({ overCap: true, action: "swap-x-for-y", receiverAddsCapacity: true }), false);
});
