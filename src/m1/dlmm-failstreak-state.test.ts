// Unit tests for the DLMM restart-survival counter persistence (external review, issue
// #6/#7). The property under test: a restart must see exactly what the last save wrote, and
// a missing/corrupt file must fail closed to {0, 0} rather than throw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDlmmCounters, saveDlmmCounters } from "./dlmm-failstreak-state.js";

const STATE_PATH = join(tmpdir(), `deepstack-dlmm-failstreak-test-${process.pid}.json`);

test("loadDlmmCounters: a missing file reads as {0, 0}, not a throw", () => {
  rmSync(STATE_PATH, { force: true });
  assert.deepEqual(loadDlmmCounters(STATE_PATH), { failStreak: 0, recenters: 0 });
});

test("saveDlmmCounters then loadDlmmCounters round-trips exactly", () => {
  saveDlmmCounters({ failStreak: 2, recenters: 7 }, STATE_PATH);
  assert.deepEqual(loadDlmmCounters(STATE_PATH), { failStreak: 2, recenters: 7 });
});

test("loadDlmmCounters: corrupt JSON fails closed to {0, 0} rather than throwing", () => {
  writeFileSync(STATE_PATH, "{ not valid json");
  assert.deepEqual(loadDlmmCounters(STATE_PATH), { failStreak: 0, recenters: 0 });
});

test("loadDlmmCounters: negative or non-numeric fields fail closed per-field", () => {
  writeFileSync(STATE_PATH, JSON.stringify({ dlmmFailStreak: -1, dlmmRecenters: "nope" }));
  assert.deepEqual(loadDlmmCounters(STATE_PATH), { failStreak: 0, recenters: 0 });
});

test("saveDlmmCounters: a write failure does not throw", () => {
  // Writing to a path that IS a directory fails with EISDIR regardless of permissions —
  // a reliable trigger whether the test runner is root (CI) or not (unlike permission-denied
  // paths, which root ignores).
  assert.doesNotThrow(() => saveDlmmCounters({ failStreak: 1, recenters: 1 }, tmpdir()));
});
