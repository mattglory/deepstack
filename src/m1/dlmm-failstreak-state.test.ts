// Unit tests for the DLMM restart-survival counter persistence (external review, issue
// #6/#7). The property under test: a restart must see exactly what the last save wrote, and
// a missing file reads as {0, 0}, and a file that exists but is unreadable/corrupt
// fails closed to TRIPPED rather than throw or reset.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDlmmCounters, saveDlmmCounters, TRIPPED_FAIL_STREAK } from "./dlmm-failstreak-state.js";
import { dlmmLiveGate } from "./agent.js";

const STATE_PATH = join(tmpdir(), `deepstack-dlmm-failstreak-test-${process.pid}.json`);

test("loadDlmmCounters: a missing file reads as {0, 0}, not a throw", () => {
  rmSync(STATE_PATH, { force: true });
  assert.deepEqual(loadDlmmCounters(STATE_PATH), { failStreak: 0, recenters: 0 });
});

test("saveDlmmCounters then loadDlmmCounters round-trips exactly", () => {
  saveDlmmCounters({ failStreak: 2, recenters: 7 }, STATE_PATH);
  assert.deepEqual(loadDlmmCounters(STATE_PATH), { failStreak: 2, recenters: 7 });
});

// C7 / DSA-13: a breaker file that EXISTS but cannot be trusted must read as TRIPPED, not as
// {0, 0} — resetting to 0 re-armed broadcasts the breaker had stopped "until a human clears it".
test("loadDlmmCounters: corrupt JSON fails closed to TRIPPED (failStreak = TRIPPED_FAIL_STREAK), not 0", () => {
  writeFileSync(STATE_PATH, "{ not valid json");
  const c = loadDlmmCounters(STATE_PATH);
  assert.equal(c.failStreak, TRIPPED_FAIL_STREAK);
  assert.equal(c.corrupt, true);
});

test("loadDlmmCounters: negative or non-numeric fields fail closed to TRIPPED", () => {
  writeFileSync(STATE_PATH, JSON.stringify({ dlmmFailStreak: -1, dlmmRecenters: "nope" }));
  const c = loadDlmmCounters(STATE_PATH);
  assert.equal(c.failStreak, TRIPPED_FAIL_STREAK);
  assert.equal(c.corrupt, true);
});

test("loadDlmmCounters: a valid JSON file missing the fields fails closed to TRIPPED", () => {
  writeFileSync(STATE_PATH, "{}");
  assert.equal(loadDlmmCounters(STATE_PATH).failStreak, TRIPPED_FAIL_STREAK);
});

test("loadDlmmCounters: a path that exists but cannot be read (EISDIR) fails closed to TRIPPED", () => {
  const dir = `${STATE_PATH}.dir`;
  mkdirSync(dir, { recursive: true });
  try {
    assert.equal(loadDlmmCounters(dir).failStreak, TRIPPED_FAIL_STREAK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TRIPPED_FAIL_STREAK is >= any configured limit (the live gate's `< limit` term is false)", () => {
  assert.ok(TRIPPED_FAIL_STREAK >= Number.MAX_SAFE_INTEGER);
});

test("saveDlmmCounters: writes atomically (no temp file left behind) and round-trips", () => {
  rmSync(STATE_PATH, { force: true });
  saveDlmmCounters({ failStreak: 1, recenters: 3 }, STATE_PATH);
  assert.deepEqual(loadDlmmCounters(STATE_PATH), { failStreak: 1, recenters: 3 });
  const base = STATE_PATH.split("/").pop()!;
  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith(`${base}.tmp`)), []);
});

test("saveDlmmCounters: a write failure does not throw", () => {
  // Writing to a path that IS a directory fails with EISDIR regardless of permissions —
  // a reliable trigger whether the test runner is root (CI) or not (unlike permission-denied
  // paths, which root ignores).
  assert.doesNotThrow(() => saveDlmmCounters({ failStreak: 1, recenters: 1 }, tmpdir()));
});

test("a corrupt state file closes dlmmLiveGate even with every other term true", () => {
  writeFileSync(STATE_PATH, "garbage");
  const c = loadDlmmCounters(STATE_PATH);
  const open = dlmmLiveGate({
    dlmmLiveFlag: true, live: true, circuitOk: true, safe: true,
    dlmmFailStreak: c.failStreak, dlmmFailStreakLimit: 1_000_000, dlmmRecenters: c.recenters, maxTrades: 1_000_000,
  });
  assert.equal(open, false);
});
