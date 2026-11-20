// Unit tests for the dashboard's P&L / IL-adjusted-return math (external review, issue #7
// — this was previously untestable: the logic lived inline in index.html's <script> with no
// way to import it without a DOM). Plain Node --test, no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hodlNow, ilAdjustedReturn, isPlausibleAgainstHodl, organicApr } from "./pnl-math.js";

const baseline = { xBase: "10000000000", yBase: "0" }; // 100 sBTC-equivalent units at 8dp, 0 STX
const sample = (over = {}) => ({ mid: 200000, stxUsd: 0.5, portfolioY: 100, ...over });

test("hodlNow: no pilotBaseline on the metrics file → null", () => {
  assert.equal(hodlNow({}, sample()), null);
});

test("hodlNow: a sample with no mid yet (0 or missing) → null", () => {
  assert.equal(hodlNow({ pilotBaseline: baseline }, sample({ mid: 0 })), null);
});

test("hodlNow: values the x+y baseline legs at the sample's mid", () => {
  // 100 units of X (8dp) * mid 200000 + 0 Y = 100 * 200000 = 20,000,000
  const v = hodlNow({ pilotBaseline: baseline }, sample());
  assert.equal(v, 100 * 200000);
});

test("hodlNow: adds LP basis legs (fixed pilotBaseline.lpBasis, not the mutable top-level one)", () => {
  const m = {
    pilotBaseline: { ...baseline, lpBasis: { xQty: 1, yQty: 50 } },
    lpBasis: { xQty: 999, yQty: 999 }, // mutable, evolved since — must NOT be used here
  };
  const v = hodlNow(m, sample());
  assert.equal(v, 100 * 200000 + 1 * 200000 + 50);
});

test("hodlNow: falls back to the mutable lpBasis only when pilotBaseline has none (pre-snapshot metrics files)", () => {
  const m = { pilotBaseline: baseline, lpBasis: { xQty: 2, yQty: 10 } };
  const v = hodlNow(m, sample());
  assert.equal(v, 100 * 200000 + 2 * 200000 + 10);
});

test("hodlNow: DLMM basis's Y leg (USDCx) needs stxUsd to value — null when the sample lacks it", () => {
  const m = { pilotBaseline: { ...baseline, dlmmBasis: { xQty: 0, yQty: 50 } } };
  assert.equal(hodlNow(m, sample({ stxUsd: 0 })), null);
});

test("hodlNow: values DLMM's X leg at mid and Y leg (USDCx) via stxUsd", () => {
  const m = { pilotBaseline: { ...baseline, dlmmBasis: { xQty: 0.001, yQty: 50 } } };
  const v = hodlNow(m, sample());
  // base legs + dlmm X (0.001 * mid) + dlmm Y (50 USDCx / stxUsd)
  assert.equal(v, 100 * 200000 + 0.001 * 200000 + 50 / 0.5);
});

test("hodlNow: pilotBaseline.usdcxQty (free USDCx at pilot start) also needs stxUsd", () => {
  const m = { pilotBaseline: { ...baseline, usdcxQty: 20 } };
  const v = hodlNow(m, sample());
  assert.equal(v, 100 * 200000 + 20 / 0.5);
  assert.equal(hodlNow(m, sample({ stxUsd: 0 })), null);
});

test("ilAdjustedReturn: null when hodlNow can't be computed", () => {
  assert.equal(ilAdjustedReturn({}, sample()), null);
});

test("ilAdjustedReturn: positive when the portfolio beats the HODL baseline", () => {
  const m = { pilotBaseline: baseline };
  const hodl = hodlNow(m, sample()); // 20,000,000
  const r = ilAdjustedReturn(m, sample({ portfolioY: hodl * 1.1 }));
  assert.ok(Math.abs(r - 10) < 1e-9);
});

test("ilAdjustedReturn: negative when the portfolio trails the HODL baseline", () => {
  const m = { pilotBaseline: baseline };
  const hodl = hodlNow(m, sample());
  const r = ilAdjustedReturn(m, sample({ portfolioY: hodl * 0.95 }));
  assert.ok(Math.abs(r - -5) < 1e-9);
});

test("isPlausibleAgainstHodl: within the default 20% band → plausible", () => {
  assert.equal(isPlausibleAgainstHodl(105, 100), true);
  assert.equal(isPlausibleAgainstHodl(119, 100), true);
});

test("isPlausibleAgainstHodl: beyond the band → filtered out (a failed-read glitch, not real IL)", () => {
  assert.equal(isPlausibleAgainstHodl(150, 100), false);
  assert.equal(isPlausibleAgainstHodl(50, 100), false);
});

test("isPlausibleAgainstHodl: a null or non-positive hodl is never plausible (nothing to compare against)", () => {
  assert.equal(isPlausibleAgainstHodl(100, null), false);
  assert.equal(isPlausibleAgainstHodl(100, 0), false);
  assert.equal(isPlausibleAgainstHodl(100, -5), false);
});

test("isPlausibleAgainstHodl: the threshold is configurable (used with pnl-math's own default of 0.2 by callers that don't override it)", () => {
  assert.equal(isPlausibleAgainstHodl(130, 100, 0.5), true);
  assert.equal(isPlausibleAgainstHodl(130, 100, 0.2), false);
});

// organicApr: extracted from index.html's two formerly-duplicated lpApr/dlmmApr blocks —
// these tests pin the exact formula so a future edit can't silently diverge the two call
// sites (XYK, native-STX y-leg) and (DLMM, USDCx y-leg needing yLegUsdRate) again.
const tenDaysAgo = new Date(Date.now() - 10 * 864e5).toISOString();

test("organicApr: native-STX y-leg (XYK-style), no gain → net 0, apr 0 once past minDays", () => {
  const r = organicApr({ currentValueY: 100, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 1 });
  assert.equal(r.netY, 0);
  assert.equal(r.apr, 0);
});

test("organicApr: native-STX y-leg with a real gain → annualised correctly", () => {
  // hodlLegs = 0*1 + 100 = 100; net = 110-100 = 10; apr = (10/100)*(365/10)*100 = 365%
  const r = organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 1 });
  assert.equal(r.netY, 10);
  assert.equal(Math.round(r.apr), 365);
});

test("organicApr: USDCx y-leg (DLMM-style) converts via yLegUsdRate, not used raw", () => {
  // basisYQty=50 USDCx, stxUsd rate 0.5 → yLegY = 50/0.5 = 100 STX-equivalent; hodlLegs = 0+100
  const r = organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 50, basisT: tenDaysAgo, mid: 1, yLegUsdRate: 0.5 });
  assert.equal(r.netY, 10);
  assert.equal(Math.round(r.apr), 365);
});

test("organicApr: net is computed even before minDays, but apr stays null (annualising a short window is how LP marketing lies)", () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 864e5).toISOString();
  const r = organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: twoDaysAgo, mid: 1 });
  assert.equal(r.netY, 10);
  assert.equal(r.apr, null);
});

test("organicApr: missing mid, currentValueY, basis quantities, or basisT → all null, never a fabricated number", () => {
  assert.deepEqual(organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 0 }), { netY: null, apr: null, days: 0 });
  assert.deepEqual(organicApr({ currentValueY: 0, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 1 }), { netY: null, apr: null, days: 0 });
  assert.deepEqual(organicApr({ currentValueY: 110, basisXQty: null, basisYQty: 100, basisT: tenDaysAgo, mid: 1 }), { netY: null, apr: null, days: 0 });
  assert.deepEqual(organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: null, mid: 1 }), { netY: null, apr: null, days: 0 });
});

test("organicApr: a non-positive yLegUsdRate is a guard failure, not a divide-by-zero/negative", () => {
  const r = organicApr({ currentValueY: 110, basisXQty: 0, basisYQty: 100, basisT: tenDaysAgo, mid: 1, yLegUsdRate: 0 });
  assert.deepEqual(r, { netY: null, apr: null, days: 0 });
});

// --- owner withdrawals (m.capitalFlows), 2026-10-22 ---
import { withdrawnUpTo, adjustedPortfolio } from "./pnl-math.js";

test("withdrawals are added back before comparing with HODL", () => {
  const m = {
    pilotBaseline: { xBase: "0", yBase: "1000000000" }, // 1,000 STX
    capitalFlows: [{ t: "2026-10-14T12:24:12Z", txid: "a", stx: -65 }, { t: "2026-10-22T16:46:03Z", txid: "c", stx: -700 }],
  };
  const before = { t: "2026-10-14T00:00:00Z", mid: 200000, portfolioY: 1000 };
  const after = { t: "2026-10-22T17:00:00Z", mid: 200000, portfolioY: 235 };
  assert.equal(withdrawnUpTo(m, before.t), 0);
  assert.equal(withdrawnUpTo(m, after.t), 765);
  assert.equal(adjustedPortfolio(m, after), 1000);
  assert.equal(ilAdjustedReturn(m, after), 0); // flat, not -76.5%
  assert.equal(ilAdjustedReturn({ pilotBaseline: m.pilotBaseline }, after), -76.5); // what it showed before
});

test("agentWallets: follows recorded rotations back from the current wallet only", async () => {
  const { agentWallets } = await import("./pnl-math.js");
  const A = "SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60";
  const B = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9";
  const C = "SP000000000000000000002Q6VF78";
  assert.deepEqual(agentWallets(null, A), { current: A, all: [A], past: [] });
  const m = { wallet: B, walletMigrations: [{ t: "2026-11-05T09:00:00Z", from: A, to: B, txids: [] }] };
  assert.deepEqual(agentWallets(m, A).all, [B, A]);
  assert.equal(agentWallets(m, A).past[0].until, "2026-11-05T09:00:00Z");
  // An entry that doesn't lead to the current wallet adds nothing.
  const stray = { wallet: B, walletMigrations: [{ t: "x", from: C, to: A }] };
  assert.deepEqual(agentWallets(stray, A).all, [B]);
  // Garbage in the telemetry falls back to the configured address.
  assert.equal(agentWallets({ wallet: "<script>" }, A).current, A);
});

test("trackRecordEnd: ends at the first owner deposit after the anchor; withdrawals don't end it", async () => {
  const { trackRecordEnd } = await import("./pnl-math.js");
  const flows = [
    { t: "2026-10-14T12:24:12Z", stx: -65 },
    { t: "2026-10-27T10:53:10Z", stx: 9000 },
    { t: "2026-10-27T08:47:21Z", stx: 3300 },
    { t: "2026-08-01T00:00:00Z", stx: 500 }, // before the anchor: not part of the track record
  ];
  assert.equal(trackRecordEnd({ capitalFlows: flows }, "2026-08-28T20:59:43Z"), "2026-10-27T08:47:21Z");
  assert.equal(trackRecordEnd({ capitalFlows: flows.filter((f) => f.stx < 0) }, "2026-08-28T20:59:43Z"), null);
  assert.equal(trackRecordEnd({}, "2026-08-28T20:59:43Z"), null);
});

test("capitalAllocation: counts both positions and free balances, in STX, summing to 100%", async () => {
  const { capitalAllocation } = await import("./pnl-math.js");
  // Shape of the 2026-11-12 10:20 sample: ~50 STX loose, the rest in the two positions.
  const a = capitalAllocation({ yBase: "49980000", xBase: "886", mid: 242580, lpValueY: 1850, dlmmValueY: 12640, freeUsdcxValueY: 460 });
  const by = Object.fromEntries(a.parts.map((p) => [p.key, p]));
  assert.ok(Math.abs(a.total - (49.98 + 0.00000886 * 242580 + 1850 + 12640 + 460)) < 1e-6);
  assert.ok(by.dlmm.pct > 80 && by.stx.pct < 1);
  assert.ok(Math.abs(a.parts.reduce((s, p) => s + p.pct, 0) - 100) < 1e-9);
  // Empty parts are left out; no positions and no balances → nothing to draw.
  assert.equal(capitalAllocation({ yBase: "0", xBase: "0", mid: 1 }).parts.length, 0);
});

test("capitalAllocation: a pending DLMM re-add is its own slice, taken out of free sBTC/USDCx (2026-11-15)", async () => {
  const { capitalAllocation } = await import("./pnl-math.js");
  // 0.0223 sBTC + 804.6 USDCx loose; 0.0412 sBTC + 595.85 USDCx are the re-add's (capped at what is there).
  const a = capitalAllocation({ yBase: "0", xBase: "2230000", mid: 240_000, stxUsd: 0.26, freeUsdcxValueY: 804.6 / 0.26, dlmmPendingX: 0.0412, dlmmPendingY: 595.85 });
  const by = Object.fromEntries(a.parts.map((p) => [p.key, p.valueY]));
  assert.equal(by.sbtc, undefined, "all loose sBTC is the re-add's");
  assert.ok(Math.abs(by["dlmm-pending"] - (0.0223 * 240_000 + 595.85 / 0.26)) < 1e-6);
  assert.ok(Math.abs(by.usdcx - (804.6 - 595.85) / 0.26) < 1e-6);
});

test("dailyCapitalSeries: one point per day, live data wins over history, USD from each day's price", async () => {
  const { dailyCapitalSeries } = await import("./pnl-math.js");
  const h = [{ t: "2026-07-10T23:00:00Z", mid: 1, xBase: "0", yBase: "100000000", lpValueY: 0, stxUsd: 0.5 }];
  const live = [{ t: "2026-07-10T23:59:00Z", mid: 1, xBase: "0", yBase: "200000000", lpValueY: 0, stxUsd: 0.5 }, { t: "2026-07-11T10:00:00Z", mid: 1, xBase: "0", yBase: "0", lpValueY: 0 }];
  const r = dailyCapitalSeries(h, [], live);
  assert.deepEqual(r.map((p) => [p.day, p.totalUsd]), [["2026-07-10", 100]], "a day without a USD price is dropped");
});

import { heartbeatUptime, heartbeatDays, walletLegs } from "./pnl-math.js";

// heartbeatUptime: measured over the retained beats' own span, not the whole pilot window.
const beatsEvery = (startIso, n, sec) => Array.from({ length: n }, (_, i) => ({ t: new Date(Date.parse(startIso) + i * sec * 1000).toISOString() }));

test("heartbeatUptime: full cadence over the retained span → 100%, even when the window started long before", () => {
  const ss = beatsEvery("2026-10-07T00:00:00Z", 2000, 1800);
  const up = heartbeatUptime(ss, 1800, "2026-08-28T20:59:43Z");
  assert.equal(up.beats, 2000);
  assert.equal(up.expected, 2000);
  assert.equal(up.pct, 100);
});

test("heartbeatUptime: missing beats inside the span lower it", () => {
  const ss = beatsEvery("2026-11-01T00:00:00Z", 100, 1800).filter((_, i) => i % 2 === 0 || i === 99);
  const up = heartbeatUptime(ss, 1800, "2026-11-01T00:00:00Z");
  assert.equal(up.expected, 100);
  assert.equal(up.beats, 51);
});

test("heartbeatUptime: no cadence or a single beat → null (n/a, never a made-up number)", () => {
  assert.equal(heartbeatUptime(beatsEvery("2026-11-01T00:00:00Z", 5, 1800), 0, "2026-11-01T00:00:00Z"), null);
  assert.equal(heartbeatUptime(beatsEvery("2026-11-01T00:00:00Z", 1, 1800), 1800, "2026-11-01T00:00:00Z"), null);
});

test("heartbeatDays: counts days with a beat across every source, and sees a dead day", () => {
  const history = [{ t: "2026-08-28T23:00:00Z" }, { t: "2026-08-29T23:00:00Z" }];
  const daily = [{ t: "2026-08-31T23:00:00Z" }];
  const samples = [{ t: "2026-09-01T10:00:00Z" }, { t: "2026-09-01T11:00:00Z" }];
  assert.deepEqual(heartbeatDays("2026-08-28T20:59:43Z", "2026-09-01T11:00:00Z", [history, daily, samples, undefined]), { covered: 4, total: 5 });
});

test("walletLegs: sums a multi-bin DLMM swap per asset and reads STX from stx_transfers, not stx_sent", () => {
  const me = "SPME", pool = "SMPOOL", sb = "x.sbtc::sbtc", us = "x.usdcx::usdcx";
  const r = {
    stx_sent: "1100300000", // includes the 0.3 STX fee
    ft_transfers: [
      { asset_identifier: us, amount: "228238218", sender: pool, recipient: me },
      { asset_identifier: us, amount: "51847118", sender: pool, recipient: me },
      { asset_identifier: sb, amount: "100", sender: pool, recipient: "SPOTHER" },
    ],
    stx_transfers: [
      { amount: "859050959", sender: me, recipient: pool },
      { amount: "194949041", sender: me, recipient: pool },
    ],
  };
  const legs = walletLegs(r, (a) => a === me, { [sb]: { sym: "sBTC", dp: 8 }, [us]: { sym: "USDCx", dp: 6 } });
  assert.deepEqual(legs.sent, { STX: 1054 });
  assert.equal(Math.round(legs.received.USDCx * 1e6), 280085336);
  assert.equal(legs.received.sBTC, undefined);
});
