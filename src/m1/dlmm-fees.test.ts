// Unit tests for on-chain DLMM fee measurement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAddLiquidityRepr, mergeDeposit, feesEarned, saveDeposit, loadDeposit, clearDeposit } from "./dlmm-fees.js";

const P = 77_500_000_000n; // 77,500 USDCx per sBTC: 775 y base units per x base unit, × 1e8 (the core's scale)

test("parse: per-bin amounts from a real add-liquidity-multi repr", () => {
  const repr = "(list (tuple (bin-id 138) (max-x-liquidity-fee u0) (max-y-liquidity-fee u40980392) (min-dlp u42116593) (pool-trait 'SM1.p) (x-amount u0) (x-token-trait 'SM3.t) (y-amount u40980392) (y-token-trait 'SP1.u)) (tuple (bin-id 238) (max-x-liquidity-fee u51251) (max-y-liquidity-fee u0) (min-dlp u1) (pool-trait 'SM1.p) (x-amount u51251) (x-token-trait 'SM3.t) (y-amount u0) (y-token-trait 'SP1.u)))";
  assert.deepEqual(parseAddLiquidityRepr(repr), [{ bin: 138, x: 0n, y: 40980392n }, { bin: 238, x: 51251n, y: 0n }]);
});

test("fees: trading inside a bin at its price changes nothing; fees paid in show up", () => {
  const dep = mergeDeposit(null, { pool: "p", owner: "A", t: "t0", txid: "a", bins: [{ bin: 1, x: 0n, y: 1_000_000_000n, price: P }] });
  // All 1,000 USDCx converted to sBTC at the bin price: same value, no fees.
  const swapped = { signedBin: 1, userX: (1_000_000_000n * 100_000_000n) / P, userY: 0n };
  assert.ok(Math.abs(Number(feesEarned(dep, [swapped])!.feesY)) < 775); // under one satoshi of rounding
  // Plus 2.5 USDCx of fees left in the bin.
  assert.equal(feesEarned(dep, [{ signedBin: 1, userX: 0n, userY: 1_002_500_000n }])!.feesY, 2_500_000n);
});

test("fees: a top-up of the same bins accumulates; a record for other bins is stale (null)", () => {
  let dep = mergeDeposit(null, { pool: "p", owner: "A", t: "t0", txid: "a", bins: [{ bin: 1, x: 0n, y: 100n, price: P }] });
  dep = mergeDeposit(dep, { pool: "p", owner: "A", t: "t1", txid: "b", bins: [{ bin: 1, x: 0n, y: 50n, price: P }, { bin: 2, x: 0n, y: 10n, price: P }] });
  assert.equal(dep.t, "t0");
  assert.deepEqual(dep.txids, ["a", "b"]);
  assert.deepEqual(dep.bins.map((b) => [b.bin, b.y]), [[1, 150n], [2, 10n]]);
  assert.equal(feesEarned(dep, [{ signedBin: 9, userX: 0n, userY: 5n }]), null);
  // A different owner (after a key rotation) starts a fresh record.
  const fresh = mergeDeposit(dep, { pool: "p", owner: "B", t: "t2", txid: "c", bins: [{ bin: 3, x: 0n, y: 1n, price: P }] });
  assert.deepEqual(fresh.bins.map((b) => b.bin), [3]);
});

test("record round-trips bigints and clears", () => {
  const path = join(tmpdir(), `deepstack-deposit-test-${process.pid}.json`);
  const dep = mergeDeposit(null, { pool: "p", owner: "A", t: "t0", txid: "a", bins: [{ bin: -3, x: 7n, y: 9n, price: P }] });
  saveDeposit(dep, path);
  assert.deepEqual(loadDeposit(path), dep);
  clearDeposit(path);
  assert.equal(loadDeposit(path), null);
});
