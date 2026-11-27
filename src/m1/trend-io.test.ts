// trend-io file handling: missing files start fresh, unreadable ones stop the mode (no silent reset).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCloses, loadTrendMemory, markChecked, usdcxReadings, trendObserveStep } from "./trend-io.js";

const dir = mkdtempSync(join(tmpdir(), "trend-io-"));

test("missing files: empty history and the risk-on starting memory", () => {
  assert.deepEqual(loadCloses(join(dir, "none.json")), { ok: true, value: [] });
  const m = loadTrendMemory(join(dir, "none2.json"));
  assert.equal(m.ok && m.value.state, "risk-on");
});

test("unreadable files: not ok, and the observe step decides nothing and leaves them as they are", async () => {
  const c = join(dir, "closes.json"), s = join(dir, "state.json");
  writeFileSync(c, "{not json");
  writeFileSync(s, JSON.stringify({ v: 1, state: "sideways" }));
  assert.equal(loadCloses(c).ok, false);
  assert.equal(loadTrendMemory(s).ok, false);
  process.env.TREND_CLOSES_PATH = c;
  process.env.TREND_STATE_PATH = s;
  try {
    const r = await trendObserveStep({ capitalUsd: null });
    assert.equal(r.ran, true);
    assert.match(r.alert ?? "", /unreadable/);
    assert.equal((r.record as any).action, "no-decision");
    assert.equal(readFileSync(c, "utf8"), "{not json");
  } finally {
    delete process.env.TREND_CLOSES_PATH;
    delete process.env.TREND_STATE_PATH;
  }
});

test("over the time budget: no decision, nothing written, retried next cycle (R104-2)", async () => {
  const c = join(dir, "b-closes.json"), s = join(dir, "b-state.json");
  process.env.TREND_CLOSES_PATH = c;
  process.env.TREND_STATE_PATH = s;
  try {
    const r = await trendObserveStep({ capitalUsd: null, force: true, budgetMs: -1 });
    assert.equal((r.record as any).action, "no-decision");
    assert.match((r.record as any).reason, /time budget.*retrying next cycle/);
    assert.equal(loadCloses(c).ok && (loadCloses(c) as any).value.length, 0);
    assert.throws(() => readFileSync(s, "utf8"));
  } finally {
    delete process.env.TREND_CLOSES_PATH;
    delete process.env.TREND_STATE_PATH;
  }
});

test("usdcxReadings: all three sources, each only when its inputs are readable", () => {
  const all = { stxUsd: 0.25, usdcxPerStx: 0.2505, llamaUsdcx: 0.999, poolUsdPerSbtc: 60_000, btcUsd: 59_940 };
  const r = usdcxReadings(all);
  assert.equal(r.readings.length, 3);
  assert.ok(Math.abs(r.bySource.stxPool! - 0.998) < 0.001);
  assert.ok(Math.abs(r.bySource.sbtcPool! - 0.999) < 0.0001);
  assert.deepEqual(usdcxReadings({ ...all, usdcxPerStx: null, llamaUsdcx: null }).readings.length, 1);
  assert.deepEqual(usdcxReadings({ stxUsd: null, usdcxPerStx: null, llamaUsdcx: null, poolUsdPerSbtc: null, btcUsd: null }).readings, []);
});

test("markChecked: counts an unverified close as verified, keeps its price, refuses unknown or verified days", () => {
  const cs = [{ day: "2026-11-19", t: 1, price: 100, verified: false, check: "no exchange candle", failedSince: "x" }, { day: "2026-11-20", t: 2, price: 200, verified: true }];
  const r = markChecked(cs, "2026-11-19", "root", new Date("2026-11-24T10:00:00Z"));
  assert.ok(r.ok);
  assert.equal(r.ok && r.closes[0].verified, true);
  assert.equal(r.ok && r.closes[0].price, 100);
  assert.match(r.ok ? r.closes[0].check! : "", /marked checked by root at 2026-11-24T10:00:00.000Z \(was: no exchange candle\)/);
  assert.equal(markChecked(cs, "2026-11-20", "root").ok, false);
  assert.equal(markChecked(cs, "2026-01-01", "root").ok, false);
});
