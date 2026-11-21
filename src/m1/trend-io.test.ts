// trend-io file handling: missing files start fresh, unreadable ones stop the mode (no silent reset).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCloses, loadTrendMemory, trendObserveStep } from "./trend-io.js";

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
