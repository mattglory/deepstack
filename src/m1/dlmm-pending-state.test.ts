import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPending, savePending, clearPending } from "./dlmm-pending-state.js";

test("pending re-add: round-trips bigints, clears, and treats junk as none", () => {
  const p = join(tmpdir(), `deepstack-pending-${process.pid}.json`);
  clearPending(p);
  assert.equal(loadPending(p), null);
  const v = { pair: "sbtc-usdcx", xBase: 5_250_000n, yBase: 12n, before: { x: 0.026, y: 2090 }, t: "2026-10-27T12:00:00Z", abortedSwaps: 1 };
  savePending(v, p);
  assert.deepEqual(loadPending(p), v);
  clearPending(p);
  assert.equal(loadPending(p), null);
});
