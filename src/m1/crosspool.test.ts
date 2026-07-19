// Tests for divergence-capture support: execution timing + the cross-pool parser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideExecTiming } from "./agent.js";
import { parseCrossPools } from "./crosspool.js";

// ---- execution timing ----

test("timing: favourable divergence executes immediately, with the edge recorded", () => {
  // buying x (swap-y-for-x) with the pool 1% cheap vs external → ~+100bps edge
  const t = decideExecTiming("swap-y-for-x", 390_000, 393_900, 0, false, 0, 6);
  assert.equal(t.execute, true);
  assert.ok(t.edgeBps > 95 && t.edgeBps < 105);
});

test("timing: unfavourable divergence defers — but only within the budget", () => {
  // buying x with the pool 1% RICH vs external → negative edge → defer
  const t = decideExecTiming("swap-y-for-x", 393_900, 390_000, 0, false, 0, 6);
  assert.equal(t.execute, false);
  // budget exhausted → executes even at bad edge (risk outranks optimisation)
  const t6 = decideExecTiming("swap-y-for-x", 393_900, 390_000, 6, false, 0, 6);
  assert.equal(t6.execute, true);
  assert.match(t6.reason, /exhausted/);
});

test("timing: urgent drift executes regardless of edge", () => {
  const t = decideExecTiming("swap-x-for-y", 380_000, 393_900, 0, true, 0, 6);
  assert.equal(t.execute, true);
  assert.match(t.reason, /urgent/);
});

test("timing: sell direction wants the pool rich; edge sign flips with direction", () => {
  const sellRich = decideExecTiming("swap-x-for-y", 393_900, 390_000, 0, false, 0, 6);
  assert.equal(sellRich.execute, true); // pool overprices x → good time to sell x
  const buyRich = decideExecTiming("swap-y-for-x", 393_900, 390_000, 0, false, 0, 6);
  assert.equal(buyRich.execute, false); // same prices, opposite trade → defer
});

test("timing: no external reference → execute (timing must never block on missing data)", () => {
  const t = decideExecTiming("swap-y-for-x", 390_000, null, 0, false, 0, 6);
  assert.equal(t.execute, true);
});

// ---- cross-pool parser (fixture uses the live ticker's real shape) ----

const FIXTURE = [
  { ticker_id: "SM3V…JFQ4.sbtc-token_Stacks", last_price: 391000, liquidity_in_usd: 280000, base_volume: 12 },
  { ticker_id: "SM3V…JFQ4.sbtc-token_SP2X….pbtc-token", last_price: 1.002, liquidity_in_usd: 250000, base_volume: 0 },
  { ticker_id: "Stacks_SP3Y….token-aeusdc", last_price: 0.165, liquidity_in_usd: 10000, base_volume: 5 }, // ≥$5k — included
  { ticker_id: "SM3V…JFQ4.sbtc-token_SP1….dust-token", last_price: 5, liquidity_in_usd: 400 }, // dust — excluded
];

test("xpool: keeps every routable pool (≥$5k), drops dust, in short form", () => {
  const out = parseCrossPools(FIXTURE);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((o) => o.pool), ["sbtc-token/Stacks", "sbtc-token/pbtc-token", "Stacks/token-aeusdc"]);
  assert.equal(out[1].liqUsd, 250000);
});

test("xpool: garbage input → empty, never a throw", () => {
  assert.deepEqual(parseCrossPools(null), []);
  assert.deepEqual(parseCrossPools({ not: "an array" }), []);
  assert.deepEqual(parseCrossPools([{ ticker_id: 42 }]), []);
});
