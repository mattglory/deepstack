// Unit tests for the persisted XYK risk state (C1 / DSA-07): lifetime trade count and drawdown
// baseline. Missing file = fresh; present but unreadable = fail closed; atomic round trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadXykTrades, saveXykTrades, EXHAUSTED_TRADES,
  loadDrawdownBaseline, saveDrawdownBaseline, baselineMismatch, type DrawdownBaseline,
} from "./risk-state.js";
import { xykLiveGate } from "./agent.js";

const DIR = mkdtempSync(join(tmpdir(), "deepstack-risk-state-"));
process.on("exit", () => rmSync(DIR, { recursive: true, force: true }));
const TRADES = join(DIR, "xyk-trades.json");
const BASE = join(DIR, "drawdown-baseline.json");
const quiet = <T>(fn: () => T): T => {
  const e = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = e; }
};

test("xyk trades: missing file reads 0; save/load round-trips; no temp file left", () => {
  rmSync(TRADES, { force: true });
  assert.deepEqual(loadXykTrades(TRADES), { trades: 0 });
  saveXykTrades(5, TRADES);
  assert.deepEqual(loadXykTrades(TRADES), { trades: 5 });
  assert.deepEqual(readdirSync(DIR).filter((f) => f.includes(".tmp-")), []);
});

test("xyk trades: corrupt, invalid or unreadable file fails closed to EXHAUSTED (gate shut)", () => {
  for (const body of ["{ nope", "{}", JSON.stringify({ trades: -1 }), JSON.stringify({ trades: 1.5 }), JSON.stringify({ trades: "3" })]) {
    writeFileSync(TRADES, body);
    const r = quiet(() => loadXykTrades(TRADES));
    assert.equal(r.trades, EXHAUSTED_TRADES, body);
    assert.equal(r.corrupt, true);
    assert.equal(xykLiveGate({ live: true, circuitOk: true, trades: r.trades, maxTrades: 1e9 }), false);
  }
  const dir = join(DIR, "trades-dir");
  mkdirSync(dir, { recursive: true });
  assert.equal(quiet(() => loadXykTrades(dir)).trades, EXHAUSTED_TRADES, "EISDIR");
});

const B: DrawdownBaseline = { portfolioY: 2500.5, t: "2026-11-01T00:00:00.000Z", pair: "sbtc-stx", wallet: "SPA" };

test("drawdown baseline: missing → none; save/load round-trips", () => {
  rmSync(BASE, { force: true });
  assert.deepEqual(loadDrawdownBaseline(BASE), { kind: "none" });
  saveDrawdownBaseline(B, BASE);
  assert.deepEqual(loadDrawdownBaseline(BASE), { kind: "ok", baseline: B });
});

test("drawdown baseline: corrupt or invalid fields → corrupt (never none)", () => {
  const bad = ["{ nope", "{}", { ...B, portfolioY: 0 }, { ...B, portfolioY: -1 }, { ...B, portfolioY: "1" }, { ...B, t: "yesterday" }, { ...B, pair: "" }, { ...B, wallet: 3 }];
  for (const body of bad) {
    writeFileSync(BASE, typeof body === "string" ? body : JSON.stringify(body));
    assert.equal(loadDrawdownBaseline(BASE).kind, "corrupt", JSON.stringify(body));
  }
  const dir = join(DIR, "base-dir");
  mkdirSync(dir, { recursive: true });
  assert.equal(loadDrawdownBaseline(dir).kind, "corrupt", "EISDIR");
});

test("baselineMismatch: same wallet, recorded rotation chain, wrong pair, unrecorded wallet", () => {
  assert.equal(baselineMismatch(B, "sbtc-stx", "SPA", []), null);
  const chain = [{ from: "SPA", to: "SPB" }, { from: "SPB", to: "SPC" }];
  assert.equal(baselineMismatch(B, "sbtc-stx", "SPC", chain), null);
  assert.match(baselineMismatch(B, "stx-aeusdc", "SPA", [])!, /pair/);
  assert.match(baselineMismatch(B, "sbtc-stx", "SPX", chain)!, /no recorded key rotation/);
  // A cycle in the migrations list terminates.
  assert.match(baselineMismatch(B, "sbtc-stx", "SPX", [{ from: "SPA", to: "SPB" }, { from: "SPB", to: "SPA" }])!, /no recorded/);
});
