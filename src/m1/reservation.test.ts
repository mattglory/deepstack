import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, pendingReaddClaims, STX } from "./reservation.js";

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
  assert.deepEqual(allocate({ [SBTC]: 999_999n }, claims, {}).problems, [], "1 unit short: indexer lag");
  assert.match(allocate({ [SBTC]: 900_000n }, claims, {}).problems[0], /over-claim on .*sbtc-token: claims 1000000 > usable 900000/);
  assert.equal(allocate({ [SBTC]: 900_000n }, claims, {}).available.dlmm[SBTC], 900_000n, "never more than is there");
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
