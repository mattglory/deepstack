// Capital-preservation mode, v1: OBSERVE ONLY (docs/CAPITAL_PRESERVATION_DESIGN.md, PR #90).
//
// Once a day the agent compares the completed daily BTC/USD close with its 60-day average and
// decides what the trend rule WOULD do: hold 30% sBTC / 70% USDCx while risk-on, 100% USDCx while
// risk-off, switching with a 2% buffer. It also measures the exit capacity a live risk-off switch
// would have had in the sBTC/USDCx pool, and the two peg checks. Nothing here builds, signs or
// sends a transaction; there is no live path in this version.
//
// This file is the pure part (unit-tested in trend.test.ts); trend-io.ts does the reads and files.

export type TrendState = "risk-on" | "risk-off";
export type TrendAction = "hold" | "to-risk-off" | "to-risk-on" | "no-decision";

/** One daily BTC/USD close (DefiLlama's daily point), with its cross-check against an exchange. */
export interface Close {
  day: string; // UTC date of the point, YYYY-MM-DD
  t: number; // the source's own timestamp (unix seconds)
  price: number; // USD
  verified: boolean; // agreed with the exchange's hourly candle within the bound
  check?: string; // what the cross-check found, for the journal
  failedSince?: string; // ISO time the cross-check first failed (alerted that day), while unverified
}

export interface TrendParams {
  smaDays: number; // TREND_SMA_DAYS
  buffer: number; // TREND_BUFFER (0.02 = 2%)
  riskShare: number; // TREND_RISK_SHARE (sBTC share while risk-on)
  maxSwitches30d: number; // TREND_MAX_SWITCHES_30D; more halts the mode
  decisionHourUtc: number; // TREND_DECISION_UTC_HOUR (the minute is randomised daily)
  closeAgreeBps: number; // close vs exchange candle (design: 1%)
  poolAgreeBps: number; // pool-implied sBTC price vs BTC/USD (design: 3%)
  usdcxPegBps: number; // USDCx vs $1 (design: 1%)
  exitMinOutBps: number; // min-out below the reference for the exit-capacity measure (design: 1%)
  unverifiedRiskOnFrac: number; // share of the window that may lack the exchange check for a risk-on (rounded down)
}

export function defaultTrendParams(): TrendParams {
  return {
    smaDays: 60, buffer: 0.02, riskShare: 0.3, maxSwitches30d: 6, decisionHourUtc: 0,
    closeAgreeBps: 100, poolAgreeBps: 300, usdcxPegBps: 100, exitMinOutBps: 100, unverifiedRiskOnFrac: 0.05,
  };
}

/** What the mode remembers between days (journal/trend-state.json). */
export interface TrendMemory {
  v: 1;
  state: TrendState;
  since: string; // ISO time the current (would-be) state began
  switches: string[]; // ISO times of would-be switches, for the 30-day limit
  lastDecisionDay: string | null; // UTC day the last decision was taken
  decisionMinute: { day: string; minute: number } | null; // today's randomised minute
  noDecisionStreak: number; // consecutive days without a decision
  halted: string | null; // why the mode stopped itself (needs a human), else null
}

/** The v1 starting holding is risk-on (30/70); the first decision then applies the rule. */
export function freshMemory(now: Date): TrendMemory {
  return { v: 1, state: "risk-on", since: now.toISOString(), switches: [], lastDecisionDay: null, decisionMinute: null, noDecisionStreak: 0, halted: null };
}

export function isTrendMemory(j: any): j is TrendMemory {
  return j?.v === 1 && (j.state === "risk-on" || j.state === "risk-off") && typeof j.since === "string" &&
    Array.isArray(j.switches) && j.switches.every((s: unknown) => typeof s === "string") &&
    (j.lastDecisionDay === null || typeof j.lastDecisionDay === "string") &&
    Number.isInteger(j.noDecisionStreak) && j.noDecisionStreak >= 0 &&
    (j.halted === null || typeof j.halted === "string");
}

/**
 * Is today's decision due? Once per UTC day, at the decision hour plus a minute drawn at random
 * each day (R90-6: a thin pool can't be front-run on a known schedule). A late start the same day
 * still decides. Returns the memory with today's minute recorded, so a restart doesn't re-draw it.
 */
export function decisionDue(now: Date, mem: TrendMemory, hourUtc: number, rand: () => number = Math.random): { due: boolean; mem: TrendMemory } {
  const day = now.toISOString().slice(0, 10);
  if (mem.lastDecisionDay === day) return { due: false, mem };
  let m = mem;
  if (mem.decisionMinute?.day !== day) m = { ...mem, decisionMinute: { day, minute: Math.floor(rand() * 60) } };
  const at = Date.parse(`${day}T00:00:00Z`) + hourUtc * 3_600_000 + m.decisionMinute!.minute * 60_000;
  return { due: now.getTime() >= at, mem: m };
}

/**
 * Cross-check a close against the exchange's hourly candle that contains its timestamp: agreed if
 * the close lies within `bps` of the candle's traded range. Two different feeds sampled a few
 * seconds apart can't match to the cent, but a close outside the hour's range by more than 1% is
 * a bad point, not timing.
 */
export function closeAgrees(price: number, candle: { low: number; high: number } | null, bps: number): { ok: boolean; check: string } {
  if (!candle || !(candle.low > 0) || !(candle.high >= candle.low)) return { ok: false, check: "no exchange candle" };
  const nearest = Math.min(Math.max(price, candle.low), candle.high);
  const offBps = Math.round((Math.abs(price - nearest) / price) * 10_000);
  return offBps <= bps
    ? { ok: true, check: `inside exchange hour ${candle.low}-${candle.high}${offBps ? ` (+${offBps}bps)` : ""}` }
    : { ok: false, check: `${offBps}bps outside exchange hour ${candle.low}-${candle.high}` };
}

export interface MergeResult {
  closes: Close[];
  corrections: { day: string; stored: number; source: number }[]; // logged and alerted, never applied
}

/**
 * Append newly fetched closes to the stored history. Append-only: a stored close is never
 * rewritten (one bad close moves SMA60 by 1/60). A source that later reports a different value for
 * a stored day is returned as a correction for the journal. An unverified stored close may be
 * upgraded to verified by a later cross-check of the SAME price.
 */
export function mergeCloses(stored: Close[], fetched: Close[], tolerance = 0.001): MergeResult {
  const byDay = new Map(stored.map((c) => [c.day, c]));
  const corrections: MergeResult["corrections"] = [];
  for (const f of fetched) {
    const s = byDay.get(f.day);
    if (!s) { byDay.set(f.day, f); continue; }
    if (Math.abs(f.price - s.price) / s.price > tolerance) corrections.push({ day: f.day, stored: s.price, source: f.price });
    else if (!s.verified && f.verified) byDay.set(f.day, { ...s, verified: true, check: f.check });
  }
  return { closes: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)), corrections };
}

/**
 * The day a DefiLlama midnight point closes. Points sit at 00:00 UTC +-10 s, so a point at 23:59:52
 * on day E is the same snapshot as 00:00:02 on E+1: both close day E. Keying by the timestamp's own
 * UTC date made them collide and left gaps (56 in Sep 2025 to Nov 2026), which would have blocked
 * decisions for a "gap in the window".
 */
export function closeDayOf(ts: number): string {
  return new Date((ts - 43_200) * 1000).toISOString().slice(0, 10);
}

/** Consecutive UTC days, no gaps. */
function contiguous(closes: Close[]): boolean {
  for (let i = 1; i < closes.length; i++) {
    if (Date.parse(`${closes[i].day}T00:00:00Z`) - Date.parse(`${closes[i - 1].day}T00:00:00Z`) !== 86_400_000) return false;
  }
  return true;
}

/** Today's other inputs. null = could not be read (fresh) this cycle. */
export interface TrendSources {
  btcSpotUsd: number | null; // fresh BTC/USD (the execution-time reference)
  poolUsdPerSbtc: number | null; // the sBTC/USDCx pool's active-bin price
  usdcxReadings: number[]; // USDCx/USD from each source that could be read (trend-io.ts usdcxReadings)
}

/**
 * The USDCx peg check (review on #104): the median of the readable sources. It blocks a switch into
 * USDCx only when at least two sources are readable and their median is more than the bound off $1,
 * so one drifting pool can't fake a depeg and block risk-off. A single off-peg reading, or too few
 * readable sources, only alerts. Pure.
 */
export function usdcxPegCheck(readings: number[], boundBps: number): { ok: boolean; median: number | null; text: string; alert: string | null } {
  const r = readings.filter((x) => x > 0).sort((a, b) => a - b);
  if (r.length === 0) return { ok: true, median: null, text: "USDCx unreadable (no source)", alert: "USDCx peg unchecked: no source readable" };
  const median = r.length % 2 ? r[(r.length - 1) / 2] : (r[r.length / 2 - 1] + r[r.length / 2]) / 2;
  const off = (x: number) => Math.round(Math.abs(x - 1) * 10_000);
  const spread = Math.round((r[r.length - 1] - r[0]) * 10_000);
  const text = `USDCx median ${median.toFixed(4)} of ${r.length} (${off(median)}bps from $1, spread ${spread}bps)`;
  const offCount = r.filter((x) => off(x) > boundBps).length;
  if (r.length >= 2 && off(median) > boundBps) return { ok: false, median, text, alert: null };
  const alert = r.length < 2 ? `USDCx peg from ${r.length} source only` : offCount > 0 ? `${offCount} USDCx source(s) off peg, median on peg` : null;
  return { ok: true, median, text, alert };
}

export interface TrendDecision {
  action: TrendAction;
  state: TrendState; // the would-be state after this decision
  reason: string;
  close: Close | null; // the close the decision used
  sma: number | null;
  offLine: number | null; // risk-off below this close
  onLine: number | null; // risk-on above this close
  checks: { close: string; pool: string; usdcx: string };
  alert: string | null;
}

const bpsOff = (a: number, b: number) => Math.round((Math.abs(a - b) / b) * 10_000);

/**
 * The rule (pure). `closes` are the stored daily closes, oldest first; the decision uses
 * yesterday's (UTC), the latest completed day, and the switch would trade after it (next-day
 * execution, as in revalidate.py). Asymmetric "no decision" (design 4.1): a wrong risk-off costs
 * upside, a wrong risk-on (or staying risk-on through a crash because a feed is down) costs capital.
 *  - to risk-off: may use a single-source close if the pool agrees with the fresh BTC/USD
 *    reference within the pool bound; needs USDCx within its peg bound (design 4.3).
 *  - to risk-on: needs a verified close AND the pool check (an sBTC peg break is not a cheap entry).
 */
export function decideTrend(closes: Close[], mem: TrendMemory, src: TrendSources, p: TrendParams, now: Date): TrendDecision {
  // Only completed days: yesterday's close is the point at today's 00:00 UTC.
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const usable = closes.filter((c) => c.day < today);
  const close = usable.at(-1) ?? null;
  const base = { state: mem.state, close, sma: null as number | null, offLine: null as number | null, onLine: null as number | null };
  const poolCheck = src.poolUsdPerSbtc && src.btcSpotUsd
    ? { ok: bpsOff(src.poolUsdPerSbtc, src.btcSpotUsd) <= p.poolAgreeBps, text: `pool ${Math.round(src.poolUsdPerSbtc)} vs BTC ${Math.round(src.btcSpotUsd)} (${bpsOff(src.poolUsdPerSbtc, src.btcSpotUsd)}bps)` }
    : { ok: false, text: "pool or BTC/USD unreadable" };
  const pegCheck = usdcxPegCheck(src.usdcxReadings, p.usdcxPegBps);
  const checks = { close: close ? `${close.verified ? "verified" : "single source"}: ${close.check ?? ""}`.trim() : "no close", pool: poolCheck.text, usdcx: pegCheck.text };
  const dayClosing = now.getUTCHours() >= 22; // a no-decision now ends the day undecided (nextMemory)
  const noDecision = (reason: string): TrendDecision => ({ ...base, action: "no-decision", reason, checks, alert: dayClosing && mem.noDecisionStreak + 1 >= 2 ? `no decision for ${mem.noDecisionStreak + 1} days in a row` : null });

  if (mem.halted) return { ...base, action: "hold", reason: `mode halted: ${mem.halted}`, checks, alert: `trend mode halted: ${mem.halted}` };
  if (!close) return noDecision("no completed close");
  if (close.day !== yesterday) return noDecision(`latest completed close is ${close.day}, not ${yesterday}`);
  const win = usable.slice(-p.smaDays);
  if (win.length < p.smaDays) return noDecision(`only ${win.length} closes, need ${p.smaDays}`);
  if (!contiguous(win)) return noDecision(`gap in the last ${p.smaDays} daily closes`);
  // An earlier close that never passed the exchange check stays in the window for 60 days, so it
  // must not block decisions that long (R104-1). Asymmetric, like the rest: risk-off and hold ignore
  // it (a wrong risk-off costs upside); risk-on tolerates 5% of the window, rounded down (3 of 60:
  // three closes each 10% wrong move SMA60 by 0.5%, well inside the 2% buffer), then waits. Each
  // unverified close is alerted the day it fails (trend-io.ts), long before the window holds three.
  const unverifiedEarlier = win.slice(0, -1).filter((c) => !c.verified).length;
  const maxUnverified = Math.floor(p.unverifiedRiskOnFrac * p.smaDays);

  const sma = win.reduce((s, c) => s + c.price, 0) / win.length;
  const offLine = sma * (1 - p.buffer), onLine = sma * (1 + p.buffer);
  const withLines = { ...base, sma, offLine, onLine };

  if (mem.state === "risk-on" && close.price < offLine) {
    if (!close.verified && !poolCheck.ok) return { ...noDecision(`close below the risk-off line but single-source and the pool check failed (${poolCheck.text})`), sma, offLine, onLine };
    if (!pegCheck.ok) return { ...noDecision(`close below the risk-off line but the USDCx check failed (${pegCheck.text})`), sma, offLine, onLine };
    return limit({ ...withLines, action: "to-risk-off", state: "risk-off", reason: `close ${Math.round(close.price)} < SMA${p.smaDays} ${Math.round(sma)} x ${1 - p.buffer}`, checks, alert: null }, mem, p, now);
  }
  if (mem.state === "risk-off" && close.price > onLine) {
    if (!close.verified) return { ...noDecision("close above the risk-on line but not verified by the exchange (risk-on needs both sources)"), sma, offLine, onLine };
    if (unverifiedEarlier > maxUnverified) return { ...noDecision(`close above the risk-on line but ${unverifiedEarlier} earlier closes in the window are unverified (risk-on allows ${maxUnverified})`), sma, offLine, onLine };
    if (!poolCheck.ok) return { ...noDecision(`close above the risk-on line but the sBTC pool check failed (${poolCheck.text})`), sma, offLine, onLine };
    return limit({ ...withLines, action: "to-risk-on", state: "risk-on", reason: `close ${Math.round(close.price)} > SMA${p.smaDays} ${Math.round(sma)} x ${1 + p.buffer}`, checks, alert: null }, mem, p, now);
  }
  return { ...withLines, action: "hold", reason: `${mem.state}: close ${Math.round(close.price)}, risk-off below ${Math.round(offLine)}, risk-on above ${Math.round(onLine)}`, checks, alert: null };
}

/** More than the allowed switches in 30 days means bad data or an extreme market: halt, alert. */
function limit(d: TrendDecision, mem: TrendMemory, p: TrendParams, now: Date): TrendDecision {
  const recent = mem.switches.filter((s) => now.getTime() - Date.parse(s) < 30 * 86_400_000).length;
  if (recent + 1 > p.maxSwitches30d) {
    return { ...d, action: "hold", state: mem.state, reason: `would be switch ${recent + 1} in 30 days (max ${p.maxSwitches30d}): mode halted`, alert: "trend mode halted: switch limit" };
  }
  return d;
}

/**
 * The memory after a decision. A no-decision (a feed or the pool unreadable) doesn't close the day:
 * the next cycle tries again, so one failed read at the decision minute can't cost a day of
 * protection. Only a day that is still undecided from 22:00 UTC counts towards the no-decision streak.
 */
export function nextMemory(mem: TrendMemory, d: TrendDecision, now: Date): TrendMemory {
  const day = now.toISOString().slice(0, 10);
  if (d.action === "no-decision" && now.getUTCHours() < 22) return mem;
  const switched = d.action === "to-risk-off" || d.action === "to-risk-on";
  return {
    ...mem,
    state: d.state,
    since: switched ? now.toISOString() : mem.since,
    switches: switched ? [...mem.switches, now.toISOString()].filter((s) => now.getTime() - Date.parse(s) < 30 * 86_400_000) : mem.switches,
    lastDecisionDay: day,
    noDecisionStreak: d.action === "no-decision" ? mem.noDecisionStreak + 1 : 0,
    halted: mem.halted ?? (d.alert === "trend mode halted: switch limit" ? d.reason : null),
  };
}

/** One bin on the sell side of the pool, active bin first then downwards. */
export interface SellBin {
  binId: number;
  yBalance: bigint; // USDCx base units the bin can pay out
  binPrice: bigint; // y base per x base, x 1e8 (the core's get-bin-price)
}

export interface ExitCapacity {
  xIn: number; // sBTC base units the pool would take
  yOut: number; // USDCx base units it would pay
  binsUsed: number;
  stoppedBy: "min-out" | "bins-read" | "empty";
}

/**
 * How much sBTC a swap-x-for-y could sell while still receiving at least the reference price less
 * `minOutBps` overall: the exit capacity of design 4.4. Follows the core's per-bin swap math: a bin
 * pays `dx * binPrice / 1e8` for `dx = x * (1 - fee)`, up to its y balance, moving down a bin when
 * it is empty. `refYperX` is the reference price in base units (USDCx base per sBTC base).
 */
export function exitCapacity(bins: SellBin[], feeBps: number, refYperX: number, minOutBps: number): ExitCapacity {
  const floor = refYperX * (1 - minOutBps / 10_000); // the overall price the swap must still beat
  let X = 0, Y = 0, used = 0;
  for (const b of bins) {
    const y = Number(b.yBalance);
    if (!(y > 0)) continue;
    const pNet = (Number(b.binPrice) / 1e8) * (1 - feeBps / 10_000); // y received per gross x in this bin
    const xFull = y / pNet;
    if (pNet >= floor) { X += xFull; Y += y; used++; continue; }
    // Below the floor: take only as much as keeps the overall price at the floor, then stop.
    const dx = Math.max(0, Math.min(xFull, (Y - X * floor) / (floor - pNet)));
    if (dx > 0) { X += dx; Y += dx * pNet; used++; }
    return { xIn: X, yOut: Y, binsUsed: used, stoppedBy: "min-out" };
  }
  return { xIn: X, yOut: Y, binsUsed: used, stoppedBy: X > 0 ? "bins-read" : "empty" };
}
