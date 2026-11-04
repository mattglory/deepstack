// Tests for the bounded band experiment's guardrails — the safety-critical part. The decisive
// properties: OFF returns the vol band untouched; when active it pins the tight band; and EACH
// of the three caps (count, cost, time) independently ends the experiment and reverts the band.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimentDecision,
  recordRebalance,
  freshState,
  loadExperimentState,
  saveExperimentState,
  type ExperimentConfig,
  type ExperimentState,
} from "./experiment.js";

const CFG = (over: Partial<ExperimentConfig> = {}): ExperimentConfig => ({
  mode: true,
  bandBps: 50,
  maxRebalances: 8,
  maxCostStx: 8,
  maxDays: 4,
  statePath: "/tmp/none.json",
  ...over,
});
const NOW = "2026-07-24T12:00:00.000Z";
const plusDays = (d: number) => new Date(Date.parse(NOW) + d * 86_400_000).toISOString();

test("OFF: returns the vol band untouched, not active", () => {
  const d = experimentDecision(CFG({ mode: false }), freshState(), 416, NOW);
  assert.equal(d.bandBps, 416);
  assert.equal(d.active, false);
});

test("active: pins the tight band and stamps startedAt on the first cycle", () => {
  const d = experimentDecision(CFG(), freshState(), 416, NOW);
  assert.equal(d.bandBps, 50);
  assert.equal(d.active, true);
  assert.equal(d.state.startedAt, NOW);
});

test("count cap: the 8th rebalance done → ends and reverts to the vol band", () => {
  const st: ExperimentState = { ...freshState(), startedAt: NOW, rebalances: 8 };
  const d = experimentDecision(CFG(), st, 416, NOW);
  assert.equal(d.active, false);
  assert.equal(d.bandBps, 416); // reverted
  assert.equal(d.state.ended, true);
  assert.match(d.state.endReason!, /max rebalances/);
});

test("cost cap: cumulative fees ≥ cap → ends", () => {
  const st: ExperimentState = { ...freshState(), startedAt: NOW, rebalances: 3, costStx: 8.01 };
  const d = experimentDecision(CFG(), st, 300, NOW);
  assert.equal(d.active, false);
  assert.match(d.state.endReason!, /cost cap/);
});

test("time cap: past maxDays → ends even with budget left", () => {
  const st: ExperimentState = { ...freshState(), startedAt: NOW, rebalances: 1, costStx: 1 };
  const d = experimentDecision(CFG(), st, 300, plusDays(4.1));
  assert.equal(d.active, false);
  assert.match(d.state.endReason!, /time cap/);
});

test("still within all caps → stays active", () => {
  const st: ExperimentState = { ...freshState(), startedAt: NOW, rebalances: 7, costStx: 7.9 };
  const d = experimentDecision(CFG(), st, 300, plusDays(3.9));
  assert.equal(d.active, true);
  assert.equal(d.bandBps, 50);
});

test("an ended experiment stays ended (never re-activates)", () => {
  const st: ExperimentState = { ...freshState(), ended: true, endReason: "max rebalances (8)" };
  const d = experimentDecision(CFG(), st, 421, NOW);
  assert.equal(d.active, false);
  assert.equal(d.bandBps, 421);
});

test("recordRebalance: increments count and accumulates fee cost", () => {
  const s1 = recordRebalance({ ...freshState(), startedAt: NOW }, 0.9123);
  assert.equal(s1.rebalances, 1);
  assert.equal(s1.costStx, 0.9123);
  const s2 = recordRebalance(s1, 1.0);
  assert.equal(s2.rebalances, 2);
  assert.equal(s2.costStx, 1.9123);
});

// C7 / DSA-13: the experiment's caps persist to a file "so a VPS restart cannot silently reset
// the counters". A corrupt file used to read as a FRESH experiment (all caps reset, tight band
// re-pinned). It must instead read as ENDED, which reverts to the vol band for good.
const EXP_PATH = join(tmpdir(), `deepstack-experiment-test-${process.pid}.json`);

test("loadExperimentState: a missing file is a fresh (not ended) experiment", () => {
  rmSync(EXP_PATH, { force: true });
  assert.deepEqual(loadExperimentState(EXP_PATH), freshState());
});

test("loadExperimentState: corrupt JSON fails closed to ENDED, and the decision reverts to the vol band", () => {
  writeFileSync(EXP_PATH, "{ truncated");
  const st = loadExperimentState(EXP_PATH);
  assert.equal(st.ended, true);
  assert.match(st.endReason!, /unreadable/);
  const d = experimentDecision(CFG(), st, 416, NOW);
  assert.equal(d.active, false);
  assert.equal(d.bandBps, 416);
});

test("loadExperimentState: valid JSON that is not an object fails closed to ENDED", () => {
  writeFileSync(EXP_PATH, "null");
  assert.equal(loadExperimentState(EXP_PATH).ended, true);
});

test("saveExperimentState: atomic write round-trips and leaves no temp file", () => {
  rmSync(EXP_PATH, { force: true });
  const st: ExperimentState = { ...freshState(), startedAt: NOW, rebalances: 2, costStx: 1.5 };
  saveExperimentState(EXP_PATH, st);
  assert.deepEqual(loadExperimentState(EXP_PATH), st);
  const base = EXP_PATH.split("/").pop()!;
  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith(`${base}.tmp`)), []);
  rmSync(EXP_PATH, { force: true });
});
