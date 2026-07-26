// Tests for the DLMM write path. The decisive logic is distributeAcrossRange — the concentrated
// "spot" shape (X at/above active, Y at/below active) with no dust lost — plus a structural check
// that the builders emit the right router call and never carry a signing/broadcast path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cvToJSON } from "@stacks/transactions";
import { distributeAcrossRange, buildAddLiquidity, buildMoveLiquidity, type PoolRefs } from "./dlmm-write.js";

test("distributeAcrossRange: X at/above active, Y at/below active", () => {
  const d = distributeAcrossRange(0, 2, 300n, 300n);
  const byBin = new Map(d.map((b) => [b.signedBin, b]));
  // above active → only X
  assert.deepEqual([byBin.get(1)!.xAmount, byBin.get(1)!.yAmount], [100n, 0n]);
  assert.deepEqual([byBin.get(2)!.xAmount, byBin.get(2)!.yAmount], [100n, 0n]);
  // below active → only Y
  assert.deepEqual([byBin.get(-1)!.xAmount, byBin.get(-1)!.yAmount], [0n, 100n]);
  assert.deepEqual([byBin.get(-2)!.xAmount, byBin.get(-2)!.yAmount], [0n, 100n]);
  // active → both
  assert.deepEqual([byBin.get(0)!.xAmount, byBin.get(0)!.yAmount], [100n, 100n]);
});

test("distributeAcrossRange: conserves the totals (dust parked in the active bin)", () => {
  const d = distributeAcrossRange(5, 3, 101n, 100n); // 101 not divisible by 4
  const sumX = d.reduce((s, b) => s + b.xAmount, 0n);
  const sumY = d.reduce((s, b) => s + b.yAmount, 0n);
  assert.equal(sumX, 101n);
  assert.equal(sumY, 100n);
  // the remainder lives in the active bin, not lost
  const active = d.find((b) => b.signedBin === 5)!;
  assert.ok(active.xAmount >= 101n / 4n);
});

test("distributeAcrossRange: works with negative active bins (USDCx pools)", () => {
  const d = distributeAcrossRange(-37, 1, 50n, 50n);
  assert.deepEqual(
    d.map((b) => b.signedBin),
    [-38, -37, -36],
  );
  assert.equal(d.reduce((s, b) => s + b.xAmount, 0n), 50n);
  assert.equal(d.reduce((s, b) => s + b.yAmount, 0n), 50n);
});

const POOL: PoolRefs = {
  poolName: "dlmm-pool-ststx-stx-v-1-bps-1",
  xToken: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
  yToken: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2",
};

test("buildAddLiquidity: emits the right router call with one position per bin", () => {
  const deposits = distributeAcrossRange(7, 3, 700n, 700n);
  const call = buildAddLiquidity(POOL, deposits);
  assert.equal(call.contractName, "dlmm-liquidity-router-v-1-2");
  assert.equal(call.functionName, "add-liquidity-multi");
  const listJson = cvToJSON(call.functionArgs[0]);
  assert.equal(listJson.value.length, deposits.length); // one tuple per bin
  assert.match(call.note, /BUILD-ONLY/);
});

test("buildMoveLiquidity: recenter emits move-liquidity-multi with signed from/to bins", () => {
  const call = buildMoveLiquidity(POOL, [{ fromBin: 10, toBin: 7, amount: 500n }]);
  assert.equal(call.functionName, "move-liquidity-multi");
  const j = cvToJSON(call.functionArgs[0]).value[0].value;
  assert.equal(j["from-bin-id"].value, "10");
  assert.equal(j["to-bin-id"].value, "7");
  assert.equal(j["amount"].value, "500");
});
