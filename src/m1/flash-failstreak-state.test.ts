// Unit tests for the autonomous flash-rebalance restart-survival counter persistence. The
// property under test: a restart must see exactly what the last save wrote, and a
// missing/corrupt file must fail closed to {0, 0} rather than throw. Mirrors
// dlmm-failstreak-state.test.ts exactly — same contract, different counters.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFlashCounters, saveFlashCounters } from "./flash-failstreak-state.js";

const STATE_PATH = join(tmpdir(), `deepstack-flash-failstreak-test-${process.pid}.json`);

test("loadFlashCounters: a missing file reads as {0, 0}, not a throw", () => {
  rmSync(STATE_PATH, { force: true });
  assert.deepEqual(loadFlashCounters(STATE_PATH), { failStreak: 0, attempts: 0 });
});

test("saveFlashCounters then loadFlashCounters round-trips exactly", () => {
  saveFlashCounters({ failStreak: 2, attempts: 7 }, STATE_PATH);
  assert.deepEqual(loadFlashCounters(STATE_PATH), { failStreak: 2, attempts: 7 });
});

test("loadFlashCounters: corrupt JSON fails closed to {0, 0} rather than throwing", () => {
  writeFileSync(STATE_PATH, "{ not valid json");
  assert.deepEqual(loadFlashCounters(STATE_PATH), { failStreak: 0, attempts: 0 });
});

test("loadFlashCounters: negative or non-numeric fields fail closed per-field", () => {
  writeFileSync(STATE_PATH, JSON.stringify({ flashFailStreak: -1, flashAttempts: "nope" }));
  assert.deepEqual(loadFlashCounters(STATE_PATH), { failStreak: 0, attempts: 0 });
});

test("saveFlashCounters: a write failure does not throw", () => {
  // Writing to a path that IS a directory fails with EISDIR regardless of permissions —
  // a reliable trigger whether the test runner is root (CI) or not.
  assert.doesNotThrow(() => saveFlashCounters({ failStreak: 1, attempts: 1 }, tmpdir()));
});
