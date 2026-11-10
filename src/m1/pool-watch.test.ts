// Unit tests for the candidate-pool watch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, type WatchObs } from "./pool-watch.js";

const o = (t: string, depth: number, changes: number): WatchObs => ({ t, pool: "p", activeBin: 45, binChangeCount: changes, nearDepthUsd: depth, windowBins: 20 });

test("the 2026-11-06 STX/sBTC reading is not ready: thin, and $600 would break the 10% cap", () => {
  const v = verdict(o("2026-11-06T06:00:00Z", 1_100, 98_359), null);
  assert.equal(v.ready, false);
  assert.ok(Math.abs(v.maxPositionUsd - 122.2) < 0.1);
  assert.equal(v.reasons.length, 3);
});

test("deep and active enough: ready, with activity measured from the previous read", () => {
  const v = verdict(o("2026-11-08T06:00:00Z", 12_000, 98_459), o("2026-11-07T06:00:00Z", 11_000, 98_359));
  assert.equal(v.binChangesPerDay, 100);
  assert.equal(v.ready, true);
});

test("reads too close together do not count as activity", () => {
  assert.equal(verdict(o("2026-11-06T07:00:00Z", 12_000, 98_400), o("2026-11-06T06:00:00Z", 12_000, 98_359)).binChangesPerDay, null);
});
