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

// --- input-cap post-conditions (Allow-mode safety, mirroring the XYK sendCapPC) ---
import { buildInputCaps, isNativeStxToken } from "./dlmm-write.js";

const STX = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const SENDER = "SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60";

test("isNativeStxToken: only the token-stx facade is native; real SIP-010s are not", () => {
  assert.equal(isNativeStxToken(STX), true);
  assert.equal(isNativeStxToken(USDCX), false);
  assert.equal(isNativeStxToken("SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token"), false);
});

test("buildInputCaps: STX facade is capped with .ustx(), SIP-010 with .ft()", () => {
  const pcs = buildInputCaps(SENDER, [
    { token: STX, asset: "", max: 3_000_000n },
    { token: USDCX, asset: "usdcx", max: 5_000_000n },
  ]) as any[];
  assert.equal(pcs.length, 2);
  assert.equal(pcs[0].type, "stx-postcondition");
  assert.equal(pcs[0].condition, "lte");
  assert.equal(pcs[0].amount, "3000000");
  assert.equal(pcs[1].type, "ft-postcondition");
  assert.equal(pcs[1].asset, `${USDCX}::usdcx`);
  assert.equal(pcs[1].amount, "5000000");
});

test("buildInputCaps: caps that send nothing are dropped (0 and negative)", () => {
  const pcs = buildInputCaps(SENDER, [
    { token: STX, asset: "", max: 0n },
    { token: USDCX, asset: "usdcx", max: -1n },
    { token: STX, asset: "", max: 1n },
  ]);
  assert.equal(pcs.length, 1);
});
