// The 2026-11-21 stale-read case: an empty position read right after a confirmed add.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheAfterDeposit, checkEmptyPosition, STALE_EMPTY_LIMIT } from "./dlmm-value-guard.js";
import type { DlmmDeposit } from "./dlmm-fees.js";

const dep: DlmmDeposit = {
  pool: "sbtc-usdcx", owner: "SPAGENT", t: "2026-11-21T05:25:49Z", txids: ["0xadd"],
  bins: [{ bin: -161, x: 2_206_334n, y: 0n, price: 0n }, { bin: -170, x: 0n, y: 1_194_293_958n, price: 0n }],
};

test("empty read with a matching deposit record → stale (reuse last), until the limit", () => {
  let streak = 0;
  for (let i = 1; i < STALE_EMPTY_LIMIT; i++) {
    const r = checkEmptyPosition(0, dep, "sbtc-usdcx", "SPAGENT", streak);
    assert.equal(r.stale, true);
    assert.equal(r.streak, i);
    streak = r.streak;
  }
  const last = checkEmptyPosition(0, dep, "sbtc-usdcx", "SPAGENT", streak);
  assert.equal(last.stale, false); // accepted, with a warning to check the record
  assert.match(last.warn ?? "", /accepting it/);
});

test("a non-empty read, no record, or another pool/owner's record → accepted, streak reset", () => {
  assert.deepEqual(checkEmptyPosition(5, dep, "sbtc-usdcx", "SPAGENT", 2), { stale: false, streak: 0, warn: null });
  assert.equal(checkEmptyPosition(0, null, "sbtc-usdcx", "SPAGENT", 0).stale, false);
  assert.equal(checkEmptyPosition(0, dep, "stx-usdcx", "SPAGENT", 0).stale, false);
  assert.equal(checkEmptyPosition(0, dep, "sbtc-usdcx", "SPOTHER", 0).stale, false);
});

test("cacheAfterDeposit: values the deposit at current prices and moves the USDCx out of free", () => {
  // 0.02206334 sBTC x 242,000 STX = 5,339.33 STX; 1,194.293958 USDCx / 0.234 = 5,103.82 STX
  const c = cacheAfterDeposit(dep, 8, 6, 242_000, 0.234, 5_393.79)!;
  assert.ok(Math.abs(c.dlmmValueY - (5_339.32828 + 5_103.8203)) < 0.01);
  assert.ok(Math.abs(c.freeUsdcxValueY - (5_393.79 - 5_103.8203)) < 0.01);
  assert.equal(cacheAfterDeposit(dep, 8, 6, 242_000, 0.234, 100)!.freeUsdcxValueY, 0); // never negative
  assert.equal(cacheAfterDeposit(null, 8, 6, 242_000, 0.234, 0), null);
  assert.equal(cacheAfterDeposit(dep, 8, 6, 0, 0.234, 0), null);
});
