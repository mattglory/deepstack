import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, pendingReaddClaims, reservationAlert, xykInventory, STX } from "./reservation.js";

import { DLMM_POOLS } from "./dlmm-read.js";

// The live pool's own pinned tokens (dlmm-read.ts), not literals: public contract principals in a
// test object trip the secret scan's generic-api-key rule.
const PIN = DLMM_POOLS.find((p) => p.key === "sbtc-usdcx")!.pin;
const SBTC = `${PIN.xToken}::${PIN.xAsset}`;
const USDCX = `${PIN.yToken}::${PIN.yAsset}`;
const STX_PIN = DLMM_POOLS.find((p) => p.key === "stx-usdcx")!.pin;
const GAS = { [STX]: 50_000_000n };

test("no claims: the XYK sees the wallet less the gas reserve (today's behaviour)", () => {
  const a = allocate({ [STX]: 158_000_000n, [SBTC]: 44_834n }, [], GAS);
  assert.deepEqual(a.available.xyk, { [STX]: 108_000_000n, [SBTC]: 44_834n });
  assert.deepEqual(a.problems, []);
});

test("2026-11-14/15 replay: with the pending re-add claimed, the XYK sees none of its sBTC", () => {
  // Wallet at 22:25 UTC on 14 Nov: the withdrawn 0.0412 sBTC + 595.85 USDCx loose, nothing else.
  const pending = { pair: "sbtc-usdcx", xBase: 4_118_337n, yBase: 595_848_263n };
  const claims = pendingReaddClaims(pending, PIN, "journal/dlmm-pending-readd.json");
  const a = allocate({ [STX]: 3_437_971_701n, [SBTC]: 4_118_337n, [USDCX]: 804_638_592n }, claims, GAS);
  assert.equal(a.available.xyk[SBTC], 0n, "the XYK step could not have traded the re-add's sBTC");
  assert.equal(a.available.dlmm[SBTC], 4_118_337n);
  assert.equal(a.available.xyk[USDCX], 804_638_592n - 595_848_263n, "the USDCx beyond the claim stays unclaimed");
  assert.deepEqual(a.problems, []);
});

test("over-claim beyond the dust tolerance is a problem; within it, not", () => {
  const claims = [{ venue: "dlmm" as const, asset: SBTC, amount: 1_000_000n, source: "x" }];
  assert.deepEqual(allocate({ [SBTC]: 1_000_000n }, claims, {}).problems, []);
  assert.deepEqual(allocate({ [SBTC]: 999_999n }, claims, {}).problems, [], "1 unit short: rounding");
  assert.equal(allocate({ [SBTC]: 998_000n }, claims, {}).problems.length, 1, "0.2% short is beyond the 10 bps rounding tolerance");
  assert.match(allocate({ [SBTC]: 900_000n }, claims, {}).problems[0], /over-claim on .*sbtc-token: claims 1000000 > usable 900000/);
  const over = allocate({ [SBTC]: 900_000n, [STX]: 100_000_000n }, claims, {});
  assert.equal(over.available.dlmm[SBTC], 0n, "an over-claim stops every venue, the claimant too");
  assert.equal(over.available.xyk[SBTC], 0n);
  assert.equal(over.available.trend[SBTC], 0n);
  assert.equal(over.available.xyk[STX], 100_000_000n, "other assets are unaffected");
});

test("two claimants over-claiming together: neither may spend the token (R101-1)", () => {
  // Each claim alone fits the balance; together they don't. Before, each got min(claim, usable).
  const claims = [
    { venue: "dlmm" as const, asset: SBTC, amount: 800_000n, source: "journal/dlmm-pending-readd.json" },
    { venue: "trend" as const, asset: SBTC, amount: 800_000n, source: "journal/trend-state.json" },
  ];
  const a = allocate({ [SBTC]: 1_000_000n, [USDCX]: 5_000_000n }, claims, {});
  assert.equal(a.available.dlmm[SBTC], 0n);
  assert.equal(a.available.trend[SBTC], 0n);
  assert.equal(a.available.xyk[SBTC], 0n);
  assert.equal(a.available.xyk[USDCX], 5_000_000n);
  assert.match(a.problems[0], /over-claim .*no venue may spend it/);
});

test("an unreadable claim source fails closed: the residual owner (XYK) gets nothing", () => {
  const a = allocate({ [STX]: 200_000_000n, [SBTC]: 100n }, [], GAS, ["journal/dlmm-pending-readd.json"]);
  assert.deepEqual(a.available.xyk, { [STX]: 0n, [SBTC]: 0n });
  assert.match(a.problems[0], /unreadable/);
});

test("pendingReaddClaims: STX facade maps to native STX; zero legs and missing pins add nothing", () => {
  assert.deepEqual(pendingReaddClaims({ pair: "stx-usdcx", xBase: 5n, yBase: 0n }, STX_PIN, "f").map((c) => c.asset), [STX]);
  assert.deepEqual(pendingReaddClaims(null, PIN, "f"), []);
  assert.deepEqual(pendingReaddClaims({ pair: "p", xBase: 1n, yBase: 1n }, undefined, "f"), []);
});

test("xykInventory: the smaller of the tradable inventory and the share; no share means nothing", () => {
  assert.deepEqual(xykInventory({ xBase: 100n, yBase: 50n }, { x: 40n, y: 80n }), { xBase: 40n, yBase: 50n });
  assert.deepEqual(xykInventory({ xBase: 100n, yBase: 50n }, null), { xBase: 0n, yBase: 0n }, "fail closed");
});

test("reservationAlert: one quiet cycle after our own transaction, then alert; unreadable always alerts", () => {
  const over = ["over-claim on X: claims 2 > usable 1 (balance 1 - gas 0); no venue may spend it"];
  assert.deepEqual(reservationAlert(over, 0, true), { alert: false, streak: 1 }, "first cycle after our own tx: graced");
  assert.deepEqual(reservationAlert(over, 1, true), { alert: true, streak: 2 }, "still there next cycle: alert");
  assert.deepEqual(reservationAlert(over, 0, false), { alert: true, streak: 1 }, "no tx of ours to explain it: alert at once");
  assert.deepEqual(reservationAlert([], 3, true), { alert: false, streak: 0 }, "cleared: streak resets");
  assert.equal(reservationAlert(["claim source unreadable: f (x)"], 0, true).alert, true);
});
