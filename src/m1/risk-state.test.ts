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

test("drawdownInputs: USD when the baseline and this cycle both have a price; y units otherwise", async () => {
  const { drawdownInputs } = await import("./risk-state.js");
  // 15,124 STX at $0.2571 = $3,888. STX rallies 20% while the sBTC/USDCx capital holds its dollar
  // value: the portfolio reads 12,603 STX, a 16.7% "loss" in STX terms, 0% in USD.
  const b = { portfolioY: 15_124, portfolioUsd: 15_124 * 0.2571 };
  const usd = drawdownInputs(b, 12_603, 0, 0.2571 * 1.2);
  assert.equal(usd.unit, "usd");
  assert.ok(Math.abs((usd.start - usd.now) / usd.start) < 0.001, "no loss in dollars, so no halt");
  const legacy = drawdownInputs({ portfolioY: 15_124 }, 12_603, 0, 0.3);
  assert.deepEqual(legacy, { start: 15_124, now: 12_603, unit: "y" }, "no USD baseline: as before");
  assert.equal(drawdownInputs(b, 12_603, 0, 0).unit, "y", "no price this cycle: y units, never mixed");
  // An owner withdrawal (y units) is added back before converting.
  const w = drawdownInputs(b, 14_124, 1_000, 0.2571);
  assert.ok(Math.abs(w.now - w.start) < 1e-6);
});

test("drawdown baseline: an optional portfolioUsd round-trips; a bad one fails closed", async () => {
  const { loadDrawdownBaseline, saveDrawdownBaseline } = await import("./risk-state.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const path = join(mkdtempSync(join(tmpdir(), "dd-usd-")), "drawdown-baseline.json");
  const b = { portfolioY: 15_124.38, t: "2026-11-17T16:13:07Z", pair: "sbtc-stx", wallet: "SP1", portfolioUsd: 3_888.4 };
  saveDrawdownBaseline(b, path);
  assert.deepEqual(loadDrawdownBaseline(path), { kind: "ok", baseline: b });
  writeFileSync(path, JSON.stringify({ ...b, portfolioUsd: -1 }));
  assert.equal(loadDrawdownBaseline(path).kind, "corrupt");
  writeFileSync(path, JSON.stringify({ portfolioY: 1, t: b.t, pair: "p", wallet: "w" }));
  assert.deepEqual(loadDrawdownBaseline(path), { kind: "ok", baseline: { portfolioY: 1, t: b.t, pair: "p", wallet: "w" } }, "older files without it still load");
});
