// Unit tests for the capital-preservation trend rule (observe only): the state machine, the
// asymmetric source rules, the peg checks, the switch limit, timing, history and exit capacity.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeAgrees, decideTrend, decisionDue, defaultTrendParams, exitCapacity, freshMemory, isTrendMemory, mergeCloses, nextMemory,
  type Close, type TrendMemory, type TrendSources,
} from "./trend.js";

const P = defaultTrendParams();
const NOW = new Date("2026-11-21T00:30:00Z");

/** n verified closes ending yesterday (2026-11-20), all at `price` except the last at `last`. */
function closes(n: number, price: number, last = price, end = "2026-11-20"): Close[] {
  const endMs = Date.parse(`${end}T08:16:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const t = endMs - (n - 1 - i) * 86_400_000;
    return { day: new Date(t).toISOString().slice(0, 10), t: t / 1000, price: i === n - 1 ? last : price, verified: true };
  });
}
const GOOD: TrendSources = { btcSpotUsd: 60_000, poolUsdPerSbtc: 59_900, usdcxUsd: 0.9995 };
const mem = (over: Partial<TrendMemory> = {}): TrendMemory => ({ ...freshMemory(NOW), ...over });

test("decideTrend: fewer closes than the SMA window → no decision", () => {
  const d = decideTrend(closes(59, 100_000), mem(), GOOD, P, NOW);
  assert.equal(d.action, "no-decision");
  assert.match(d.reason, /only 59 closes/);
});

test("decideTrend: a missing day in the window → no decision", () => {
  const cs = closes(61, 100_000);
  cs.splice(30, 1);
  assert.match(decideTrend(cs, mem(), GOOD, P, NOW).reason, /gap/);
});

test("decideTrend: an unverified earlier close in the window → no decision", () => {
  const cs = closes(60, 100_000);
  cs[10] = { ...cs[10], verified: false };
  assert.match(decideTrend(cs, mem(), GOOD, P, NOW).reason, /not verified/);
});

test("decideTrend: today's (still revised) point is ignored; a stale latest close → no decision", () => {
  const cs = [...closes(60, 100_000), { day: "2026-11-21", t: Date.parse("2026-11-21T08:16:00Z") / 1000, price: 1, verified: true }];
  assert.equal(decideTrend(cs, mem(), GOOD, P, NOW).action, "hold"); // the 1-dollar "today" point is not used
  const old = closes(60, 100_000, 100_000, "2026-11-18");
  assert.match(decideTrend(old, mem(), GOOD, P, NOW).reason, /not 2026-11-20/);
});

test("decideTrend: inside the buffer → hold, with both lines reported", () => {
  const d = decideTrend(closes(60, 100_000, 99_000), mem(), GOOD, P, NOW);
  assert.equal(d.action, "hold");
  assert.equal(d.state, "risk-on");
  assert.ok(d.offLine! < 99_000 && d.onLine! > 99_000);
});

test("decideTrend: verified close below SMA x 0.98 while risk-on → to-risk-off", () => {
  const d = decideTrend(closes(60, 100_000, 90_000), mem(), GOOD, P, NOW);
  assert.equal(d.action, "to-risk-off");
  assert.equal(d.state, "risk-off");
});

test("decideTrend: risk-off may use a single-source close when the pool agrees with BTC/USD", () => {
  const cs = closes(60, 100_000, 90_000);
  cs[59] = { ...cs[59], verified: false };
  assert.equal(decideTrend(cs, mem(), GOOD, P, NOW).action, "to-risk-off");
  const badPool = { ...GOOD, poolUsdPerSbtc: 50_000 };
  const d = decideTrend(cs, mem(), badPool, P, NOW);
  assert.equal(d.action, "no-decision");
  assert.match(d.reason, /single-source and the pool check failed/);
});

test("decideTrend: risk-off needs USDCx within 1% of $1 (unreadable counts as failed)", () => {
  const cs = closes(60, 100_000, 90_000);
  assert.match(decideTrend(cs, mem(), { ...GOOD, usdcxUsd: 0.985 }, P, NOW).reason, /USDCx check failed/);
  assert.equal(decideTrend(cs, mem(), { ...GOOD, usdcxUsd: null }, P, NOW).action, "no-decision");
});

test("decideTrend: risk-on needs a verified close AND the sBTC pool check", () => {
  const off = mem({ state: "risk-off" });
  const cs = closes(60, 100_000, 110_000);
  assert.equal(decideTrend(cs, off, GOOD, P, NOW).action, "to-risk-on");
  const single = cs.map((c, i) => (i === 59 ? { ...c, verified: false } : c));
  assert.match(decideTrend(single, off, GOOD, P, NOW).reason, /needs both sources/);
  assert.match(decideTrend(cs, off, { ...GOOD, poolUsdPerSbtc: 57_000 }, P, NOW).reason, /sBTC pool check failed/);
  assert.equal(decideTrend(cs, off, { ...GOOD, btcSpotUsd: null }, P, NOW).action, "no-decision");
});

test("decideTrend: a 7th switch in 30 days halts the mode instead of switching", () => {
  const switches = Array.from({ length: 6 }, (_, i) => new Date(NOW.getTime() - (i + 1) * 86_400_000).toISOString());
  const d = decideTrend(closes(60, 100_000, 90_000), mem({ switches }), GOOD, P, NOW);
  assert.equal(d.action, "hold");
  assert.equal(d.state, "risk-on");
  assert.equal(d.alert, "trend mode halted: switch limit");
  const m = nextMemory(mem({ switches }), d, NOW);
  assert.ok(m.halted);
  assert.match(decideTrend(closes(60, 100_000, 90_000), m, GOOD, P, NOW).reason, /mode halted/);
});

test("no-decision: retried within the day; a day still undecided at 22:00 counts; the second such day alerts", () => {
  const m0 = mem();
  const d0 = decideTrend(closes(10, 100_000), m0, GOOD, P, NOW);
  assert.equal(d0.action, "no-decision");
  assert.equal(nextMemory(m0, d0, NOW), m0); // 00:30: unchanged, so the next cycle tries again
  const late = new Date("2026-11-21T22:10:00Z");
  const d1 = decideTrend(closes(10, 100_000), m0, GOOD, P, late);
  assert.equal(d1.alert, null);
  const m1 = nextMemory(m0, d1, late);
  assert.equal(m1.noDecisionStreak, 1);
  assert.equal(m1.lastDecisionDay, "2026-11-21");
  const next = new Date("2026-11-22T22:10:00Z");
  assert.match(decideTrend(closes(10, 100_000, 100_000, "2026-11-21"), m1, GOOD, P, next).alert ?? "", /2 days in a row/);
});

test("nextMemory: a switch is logged and resets the streak; a hold keeps the state", () => {
  const d = decideTrend(closes(60, 100_000, 90_000), mem({ noDecisionStreak: 3 }), GOOD, P, NOW);
  const m = nextMemory(mem({ noDecisionStreak: 3 }), d, NOW);
  assert.equal(m.state, "risk-off");
  assert.equal(m.switches.length, 1);
  assert.equal(m.noDecisionStreak, 0);
  assert.equal(m.lastDecisionDay, "2026-11-21");
  assert.ok(isTrendMemory(m));
});

test("decisionDue: random minute drawn once a day, kept across restarts, one decision a day", () => {
  const m0 = freshMemory(NOW);
  const early = decisionDue(new Date("2026-11-21T00:10:00Z"), m0, 0, () => 0.5); // minute 30
  assert.equal(early.due, false);
  assert.deepEqual(early.mem.decisionMinute, { day: "2026-11-21", minute: 30 });
  const later = decisionDue(new Date("2026-11-21T00:31:00Z"), early.mem, 0, () => 0.99); // not re-drawn
  assert.equal(later.due, true);
  assert.equal(later.mem.decisionMinute!.minute, 30);
  const done = { ...later.mem, lastDecisionDay: "2026-11-21" };
  assert.equal(decisionDue(new Date("2026-11-21T23:00:00Z"), done, 0).due, false);
  assert.equal(decisionDue(new Date("2026-11-22T05:00:00Z"), done, 0, () => 0).due, true); // late start still decides
});

test("closeAgrees: inside the hour's range, or within the bound of it; missing candle fails", () => {
  assert.equal(closeAgrees(100, { low: 99, high: 101 }, 100).ok, true);
  assert.equal(closeAgrees(101.5, { low: 99, high: 101 }, 100).ok, true); // ~49bps above the high
  assert.equal(closeAgrees(103, { low: 99, high: 101 }, 100).ok, false);
  assert.equal(closeAgrees(100, null, 100).ok, false);
});

test("mergeCloses: append-only; a changed source value is a correction, not applied; verification can upgrade", () => {
  const a: Close = { day: "2026-11-19", t: 1, price: 100, verified: false };
  const b: Close = { day: "2026-11-20", t: 2, price: 200, verified: true };
  const r = mergeCloses([a, b], [{ ...a, verified: true, check: "ok" }, { ...b, price: 210 }, { day: "2026-11-21", t: 3, price: 300, verified: false }]);
  assert.deepEqual(r.closes.map((c) => [c.day, c.price, c.verified]), [["2026-11-19", 100, true], ["2026-11-20", 200, true], ["2026-11-21", 300, false]]);
  assert.deepEqual(r.corrections, [{ day: "2026-11-20", stored: 200, source: 210 }]);
});

// Exit capacity. Base units with price 1e8-scaled; ref 100 y per x, fee 0, 1% min-out → floor 99.
const bin = (binId: number, y: number, price: number) => ({ binId, yBalance: BigInt(y), binPrice: BigInt(Math.round(price * 1e8)) });

test("exitCapacity: bins at or above the floor are taken whole", () => {
  const c = exitCapacity([bin(0, 1000, 100), bin(-1, 1000, 99.5)], 0, 100, 100);
  assert.equal(c.binsUsed, 2);
  assert.equal(c.yOut, 2000);
  assert.equal(c.stoppedBy, "bins-read");
});

test("exitCapacity: a bin below the floor is taken only until the overall price reaches the floor", () => {
  const c = exitCapacity([bin(0, 1000, 100), bin(-1, 1000, 98)], 0, 100, 100);
  assert.equal(c.stoppedBy, "min-out");
  // X = 10 + dx, Y = 1000 + 98dx, Y/X = 99 → dx = (1000 - 990) / 1 = 10
  assert.ok(Math.abs(c.xIn - 20) < 1e-9);
  assert.ok(Math.abs(c.yOut / c.xIn - 99) < 1e-9);
});

test("exitCapacity: the fee counts against the min-out; a pool already below the floor takes nothing", () => {
  const withFee = exitCapacity([bin(0, 1000, 99.5)], 100, 100, 100); // 99.5 x 0.99 = 98.5 < 99
  assert.equal(withFee.xIn, 0);
  assert.equal(withFee.stoppedBy, "min-out");
  assert.equal(exitCapacity([bin(0, 0, 100)], 0, 100, 100).stoppedBy, "empty");
});
