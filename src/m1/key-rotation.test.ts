// Unit tests for the key-rotation plan: what moves, in what order, and what blocks it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ROTATION_ASSETS, ROTATION_FEE_USTX, parseBalances, planRotation, isDrained, fmtUnits } from "./key-rotation.js";

const [LP, SBTC, USDCX] = ROTATION_ASSETS.map((a) => a.id);
const DLMM = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10::pool-token";
const DUST = "SP000000000000000000002Q6VF78.junk::junk";

test("parseBalances: keeps only nonzero tokens", () => {
  const b = parseBalances({ stx: { balance: "5000000", locked: "0" }, fungible_tokens: { [SBTC]: { balance: "100" }, [USDCX]: { balance: "0" } } });
  assert.equal(b.stx, 5_000_000n);
  assert.deepEqual(Object.keys(b.ft), [SBTC]);
});

test("plan: known tokens in fixed order, STX last net of every fee, unknown tokens left alone", () => {
  const p = planRotation({ stx: 50_000_000n, stxLocked: 0n, ft: { [USDCX]: 7n, [SBTC]: 3n, [LP]: 9n, [DUST]: 1n } });
  assert.deepEqual(p.tokens.map((t) => t.asset.id), [LP, SBTC, USDCX]);
  assert.deepEqual(p.tokens.map((t) => t.amount), [9n, 3n, 7n]);
  assert.equal(p.feesTotal, ROTATION_FEE_USTX * 4n);
  assert.equal(p.stxSend, 50_000_000n - ROTATION_FEE_USTX * 4n);
  assert.deepEqual(p.ignored, [DUST]);
  assert.deepEqual(p.blockers, []);
});

test("plan: an open DLMM position, locked STX, or too little STX for fees each block", () => {
  assert.match(planRotation({ stx: 50_000_000n, stxLocked: 0n, ft: { [DLMM]: 1n } }).blockers[0], /DLMM position still open/);
  assert.match(planRotation({ stx: 50_000_000n, stxLocked: 1n, ft: {} }).blockers[0], /locked/);
  const poor = planRotation({ stx: 150_000n, stxLocked: 0n, ft: { [SBTC]: 1n } });
  assert.match(poor.blockers[0], /not enough STX/);
  assert.equal(poor.stxSend, 0n);
});

test("isDrained: only dust STX and no known tokens or DLMM shares", () => {
  assert.equal(isDrained({ stx: 100_000n, stxLocked: 0n, ft: { [DUST]: 5n } }), true);
  assert.equal(isDrained({ stx: 100_001n, stxLocked: 0n, ft: {} }), false);
  assert.equal(isDrained({ stx: 0n, stxLocked: 0n, ft: { [SBTC]: 1n } }), false);
  assert.equal(isDrained({ stx: 0n, stxLocked: 0n, ft: { [DLMM]: 1n } }), false);
});

test("fmtUnits", () => {
  assert.equal(fmtUnits(1_690_000n, 8), "0.0169");
  assert.equal(fmtUnits(2_842_800_000n, 6), "2842.8");
  assert.equal(fmtUnits(0n, 6), "0");
});
