// Unit tests for the autonomous flash-rebalance restart-survival counter persistence. The
// property under test: a restart must see exactly what the last save wrote, a missing file
// reads as {0, 0}, and a file that exists but is unreadable/corrupt fails closed to TRIPPED
// rather than throw or reset. Mirrors
// dlmm-failstreak-state.test.ts exactly — same contract, different counters.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFlashCounters, saveFlashCounters, TRIPPED_FAIL_STREAK } from "./flash-failstreak-state.js";
import { flashLiveGate } from "./agent.js";

const STATE_PATH = join(tmpdir(), `deepstack-flash-failstreak-test-${process.pid}.json`);

test("loadFlashCounters: a missing file reads as {0, 0}, not a throw", () => {
  rmSync(STATE_PATH, { force: true });
  assert.deepEqual(loadFlashCounters(STATE_PATH), { failStreak: 0, attempts: 0 });
});

test("saveFlashCounters then loadFlashCounters round-trips exactly", () => {
  saveFlashCounters({ failStreak: 2, attempts: 7 }, STATE_PATH);
  assert.deepEqual(loadFlashCounters(STATE_PATH), { failStreak: 2, attempts: 7 });
});

// C7 / DSA-13: a breaker file that EXISTS but cannot be trusted must read as TRIPPED, not as
// {0, 0} — resetting to 0 re-armed broadcasts the breaker had stopped "until a human clears it".
test("loadFlashCounters: corrupt JSON fails closed to TRIPPED (failStreak = TRIPPED_FAIL_STREAK), not 0", () => {
  writeFileSync(STATE_PATH, "{ not valid json");
  const c = loadFlashCounters(STATE_PATH);
  assert.equal(c.failStreak, TRIPPED_FAIL_STREAK);
  assert.equal(c.corrupt, true);
});

test("loadFlashCounters: negative or non-numeric fields fail closed to TRIPPED", () => {
  writeFileSync(STATE_PATH, JSON.stringify({ flashFailStreak: -1, flashAttempts: "nope" }));
  const c = loadFlashCounters(STATE_PATH);
  assert.equal(c.failStreak, TRIPPED_FAIL_STREAK);
  assert.equal(c.corrupt, true);
});

test("loadFlashCounters: a valid JSON file missing the fields fails closed to TRIPPED", () => {
  writeFileSync(STATE_PATH, "{}");
  assert.equal(loadFlashCounters(STATE_PATH).failStreak, TRIPPED_FAIL_STREAK);
});

test("loadFlashCounters: a path that exists but cannot be read (EISDIR) fails closed to TRIPPED", () => {
  const dir = `${STATE_PATH}.dir`;
  mkdirSync(dir, { recursive: true });
  try {
    assert.equal(loadFlashCounters(dir).failStreak, TRIPPED_FAIL_STREAK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TRIPPED_FAIL_STREAK is >= any configured limit (the live gate's `< limit` term is false)", () => {
  assert.ok(TRIPPED_FAIL_STREAK >= Number.MAX_SAFE_INTEGER);
});

test("saveFlashCounters: writes atomically (no temp file left behind) and round-trips", () => {
  rmSync(STATE_PATH, { force: true });
  saveFlashCounters({ failStreak: 1, attempts: 3 }, STATE_PATH);
  assert.deepEqual(loadFlashCounters(STATE_PATH), { failStreak: 1, attempts: 3 });
  const base = STATE_PATH.split("/").pop()!;
  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith(`${base}.tmp`)), []);
});

test("saveFlashCounters: a write failure does not throw", () => {
  // Writing to a path that IS a directory fails with EISDIR regardless of permissions —
  // a reliable trigger whether the test runner is root (CI) or not.
  assert.doesNotThrow(() => saveFlashCounters({ failStreak: 1, attempts: 1 }, tmpdir()));
});

test("a corrupt state file closes flashLiveGate even with every other term true", () => {
  writeFileSync(STATE_PATH, "garbage");
  const c = loadFlashCounters(STATE_PATH);
  const open = flashLiveGate({
    flashLiveFlag: true, live: true, circuitOk: true, safe: true,
    flashFailStreak: c.failStreak, flashFailStreakLimit: 1_000_000, flashAttempts: c.attempts, maxTrades: 1_000_000, network: "mainnet",
  });
  assert.equal(open, false);
});
