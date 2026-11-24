// Capital-preservation mode, observe only: the reads and the files around trend.ts.
//
// Sources (design 4.1, 4.3, 4.4):
//   - daily BTC/USD closes: DefiLlama chart/coingecko:bitcoin period 1d, the series the backtest
//     used. Its daily points fall at the time of day of the query's start, so the start is set to
//     00:00 UTC: each point is then the midnight close, as in the backtest, labelled by the day it
//     closes (closeDayOf). Each is cross-checked against the Coinbase BTC-USD hourly candle containing it.
//   - BTC/USD now: DefiLlama current price (at most 15 minutes old).
//   - USDCx/USD (readUsdcx, R104-3/4): first the STX/USDCx pool's price against STX/USD, which is
//     independent of the sBTC/USDCx pool the sBTC check reads; then DefiLlama's on-chain USDCx price;
//     then the sBTC/USDCx pool against BTC/USD. The source used is recorded, and a fallback alerts.
//   - the sBTC/USDCx HODLMM pool: active-bin price, fee and the bins below it (pinned tokens).
// Files (atomic writes; an unreadable file means no decision and an alert, never a silent reset):
//   journal/trend-closes.json  append-only close history
//   journal/trend-state.json   the would-be state, switch log and today's decision minute
// Nothing here signs or broadcasts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DLMM_POOLS, pinMismatch, readBinLiquidityStates, readDlmmState } from "./dlmm-read.js";
import { readUserPosition } from "./dlmm-position.js";
import {
  closeAgrees, closeDayOf, decideTrend, decisionDue, exitCapacity, freshMemory, isTrendMemory, mergeCloses, nextMemory,
  type Close, type TrendDecision, type TrendMemory, type TrendParams, type TrendSources, type SellBin, defaultTrendParams,
} from "./trend.js";

const TIMEOUT_MS = 10_000;
const MAX_SELL_BINS = 40;
const MAX_VERIFY_PER_RUN = 10; // exchange checks per run, newest first; a cold start catches up over a few cycles

/** The step's total time inside the trading cycle (R104-2). Over it: no decision this cycle, retried next. */
class OverBudget extends Error {}
function budget(ms: number): (stage: string) => void {
  const end = Date.now() + ms;
  return (stage) => { if (Date.now() > end) throw new OverBudget(`over the ${Math.round(ms / 1000)}s time budget at ${stage}`); };
}

export function trendClosesPath(): string { return process.env.TREND_CLOSES_PATH ?? "journal/trend-closes.json"; }
export function trendStatePath(): string { return process.env.TREND_STATE_PATH ?? "journal/trend-state.json"; }

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number (got '${raw}')`);
  return n;
}

export function trendParams(): TrendParams {
  const d = defaultTrendParams();
  return {
    ...d,
    smaDays: envNum("TREND_SMA_DAYS", d.smaDays),
    buffer: envNum("TREND_BUFFER", d.buffer),
    riskShare: envNum("TREND_RISK_SHARE", d.riskShare),
    maxSwitches30d: envNum("TREND_MAX_SWITCHES_30D", d.maxSwitches30d),
    decisionHourUtc: envNum("TREND_DECISION_UTC_HOUR", d.decisionHourUtc),
  };
}

function atomicWrite(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

type Load<T> = { ok: true; value: T } | { ok: false; reason: string };

export function loadCloses(path = trendClosesPath()): Load<Close[]> {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: [] };
    return { ok: false, reason: `${path}: ${(e as Error).message}` };
  }
  try {
    const j = JSON.parse(raw);
    const ok = j?.v === 1 && Array.isArray(j.closes) && j.closes.every((c: any) =>
      /^\d{4}-\d{2}-\d{2}$/.test(c?.day) && Number.isFinite(c?.t) && c?.price > 0 && typeof c?.verified === "boolean");
    return ok ? { ok: true, value: j.closes } : { ok: false, reason: `${path}: invalid contents` };
  } catch (e) {
    return { ok: false, reason: `${path}: ${(e as Error).message}` };
  }
}

export function loadTrendMemory(path = trendStatePath(), now = new Date()): Load<TrendMemory> {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: freshMemory(now) };
    return { ok: false, reason: `${path}: ${(e as Error).message}` };
  }
  try {
    const j = JSON.parse(raw);
    return isTrendMemory(j) ? { ok: true, value: j } : { ok: false, reason: `${path}: invalid contents` };
  } catch (e) {
    return { ok: false, reason: `${path}: ${(e as Error).message}` };
  }
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { "User-Agent": "deepstack-agent" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}

/** DefiLlama's daily BTC/USD points for the last `days` completed days (unverified until cross-checked). */
export async function fetchLlamaCloses(days: number, now = new Date()): Promise<Close[]> {
  // Start at 00:00 UTC so every point is a midnight close (a start at 08:16 gives 08:16 snapshots).
  const start = (Math.floor(now.getTime() / 86_400_000) - days) * 86_400;
  const j = await getJson(`https://coins.llama.fi/chart/coingecko:bitcoin?start=${start}&span=${days + 1}&period=1d`);
  const pts: { timestamp: number; price: number }[] = j?.coins?.["coingecko:bitcoin"]?.prices ?? [];
  const today = now.toISOString().slice(0, 10);
  const byDay = new Map<string, Close>();
  for (const x of pts) {
    if (!(x.price > 0) || !(x.timestamp > 0)) continue;
    const day = closeDayOf(x.timestamp);
    if (day >= today || x.timestamp * 1000 > now.getTime()) continue; // only completed days are stored
    byDay.set(day, { day, t: x.timestamp, price: x.price, verified: false });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Coinbase BTC-USD hourly candle containing `t` (unix s), or null. */
export async function fetchExchangeHour(t: number): Promise<{ low: number; high: number } | null> {
  const h = Math.floor(t / 3600) * 3600;
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const rows: number[][] = await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=${iso(h)}&end=${iso(h + 3600)}`);
  const c = (rows ?? []).find((r) => r[0] === h); // [time, low, high, open, close, volume]
  return c ? { low: c[1], high: c[2] } : null;
}

/**
 * Cross-check closes that aren't verified yet (new ones, and earlier ones whose check failed), newest
 * first, at most MAX_VERIFY_PER_RUN. Returns the closes and the days that failed for the first time
 * this run (each alerted that day, R104-1).
 */
async function verify(closes: Close[], agreeBps: number, now: Date, check: (stage: string) => void): Promise<{ closes: Close[]; newlyFailed: string[] }> {
  const out = [...closes];
  const newlyFailed: string[] = [];
  const todo = out.map((c, i) => i).filter((i) => !out[i].verified).reverse().slice(0, MAX_VERIFY_PER_RUN);
  for (const i of todo) {
    check("close verification");
    const c = out[i];
    let r: { ok: boolean; check: string };
    try {
      r = closeAgrees(c.price, await fetchExchangeHour(c.t), agreeBps);
    } catch (e) {
      r = { ok: false, check: `exchange unreadable: ${(e as Error).message}` };
    }
    if (r.ok) out[i] = { day: c.day, t: c.t, price: c.price, verified: true, check: r.check };
    else {
      if (!c.failedSince) newlyFailed.push(`${c.day} (${r.check})`);
      out[i] = { ...c, verified: false, check: r.check, failedSince: c.failedSince ?? now.toISOString() };
    }
  }
  return { closes: out, newlyFailed };
}

/**
 * A human marks a close checked after looking at it (R104-1): it counts as verified from then on.
 * The price is never changed. Returns the updated history, or why it couldn't.
 */
export function markChecked(closes: Close[], day: string, by: string, now = new Date()): { ok: true; closes: Close[] } | { ok: false; reason: string } {
  const i = closes.findIndex((c) => c.day === day);
  if (i < 0) return { ok: false, reason: `no stored close for ${day}` };
  if (closes[i].verified) return { ok: false, reason: `${day} is already verified (${closes[i].check ?? ""})` };
  const out = [...closes];
  out[i] = { day: closes[i].day, t: closes[i].t, price: closes[i].price, verified: true, check: `marked checked by ${by} at ${now.toISOString()} (was: ${closes[i].check ?? "unverified"})` };
  return { ok: true, closes: out };
}

export function saveCloses(closes: Close[], path = trendClosesPath()): void {
  atomicWrite(path, { v: 1, closes });
}

async function llamaCurrent(key: string, maxAgeSecs: number, nowS: number): Promise<number | null> {
  try {
    const j = await getJson(`https://coins.llama.fi/prices/current/${key}`);
    const c = j?.coins?.[key];
    return c?.price > 0 && nowS - Number(c.timestamp) <= maxAgeSecs ? c.price : null;
  } catch {
    return null;
  }
}

interface PoolRead { usdPerSbtc: number; feeBps: number; bins: SellBin[]; refYperX: number }

/** The sBTC/USDCx pool's active price and the bins a sell would walk down, read until the
 *  first bin below the exit floor (or MAX_SELL_BINS). Pinned tokens and core, or it throws.
 *  `owner`'s own liquidity is left out: a live switch withdraws the agent's DLMM position first
 *  (design 4.5), so it can't sell into it. */
async function readSellSide(btcSpotUsd: number | null, p: TrendParams, owner: string | null, check: (stage: string) => void): Promise<PoolRead> {
  const pool = DLMM_POOLS.find((x) => x.key === "sbtc-usdcx")!;
  const st = await readDlmmState(pool);
  if (!st) throw new Error("sbtc-usdcx pool unreadable");
  const bad = pinMismatch(pool, st);
  if (bad) throw new Error(`pin mismatch: ${bad}`);
  const feeBps = st.swapFeeBps;
  if (!(feeBps !== undefined && feeBps >= 0 && feeBps < 10_000)) throw new Error("pool fee unreadable");
  const scale = 10 ** (pool.pin.xDecimals - pool.pin.yDecimals); // base-unit price -> USDCx per sBTC
  const own = new Map<number, bigint>();
  if (owner) for (const b of (await readUserPosition(pool, owner)).bins) own.set(b.signedBin, b.userY);
  const ref = btcSpotUsd ?? null;
  const bins: SellBin[] = [];
  let usdPerSbtc = NaN;
  for (let k = 0; k < MAX_SELL_BINS; k++) {
    check("exit-capacity bin reads");
    const id = st.activeBinId - k;
    const s = (await readBinLiquidityStates(pool, st.coreAddress, st.initialPrice, st.binStep, [id])).get(id)!;
    if (k === 0) usdPerSbtc = (Number(s.binPrice) / 1e8) * scale;
    const ownY = own.get(id) ?? 0n;
    bins.push({ binId: id, yBalance: s.yBalance > ownY ? s.yBalance - ownY : 0n, binPrice: s.binPrice });
    if (ref === null) break; // no reference: price only, no capacity walk
    const pNet = (Number(s.binPrice) / 1e8) * scale * (1 - feeBps / 10_000);
    if (s.yBalance > 0n && pNet < ref * (1 - p.exitMinOutBps / 10_000)) break;
  }
  return { usdPerSbtc, feeBps, bins, refYperX: ref === null ? NaN : ref / scale };
}

/** USDCx per STX from the STX/USDCx pool's active bin (pinned tokens and core), or null. */
async function stxPoolUsdcxPerStx(): Promise<number | null> {
  try {
    const pool = DLMM_POOLS.find((x) => x.key === "stx-usdcx-v1")!;
    const st = await readDlmmState(pool);
    if (!st || pinMismatch(pool, st)) return null;
    const s = (await readBinLiquidityStates(pool, st.coreAddress, st.initialPrice, st.binStep, [st.activeBinId])).get(st.activeBinId);
    return s ? (Number(s.binPrice) / 1e8) * 10 ** (pool.pin.xDecimals - pool.pin.yDecimals) : null;
  } catch {
    return null;
  }
}

/**
 * USDCx/USD for the peg check (R104-3/4). The first source is independent of the sBTC/USDCx pool, so
 * a USDCx depeg can't hide inside the sBTC check: the STX/USDCx pool against STX/USD. Fallbacks, each
 * alerted: DefiLlama's on-chain USDCx price, then the sBTC/USDCx pool against BTC/USD. Pure given its
 * inputs; all of them are logged.
 */
export function pickUsdcx(inp: { stxUsd: number | null; usdcxPerStx: number | null; llamaUsdcx: number | null; poolUsdPerSbtc: number | null; btcUsd: number | null }): { usd: number | null; source: string; fallback: boolean } {
  if (inp.stxUsd && inp.usdcxPerStx) return { usd: inp.stxUsd / inp.usdcxPerStx, source: "STX/USDCx pool vs STX/USD", fallback: false };
  if (inp.llamaUsdcx) return { usd: inp.llamaUsdcx, source: "DefiLlama on-chain price", fallback: true };
  if (inp.poolUsdPerSbtc && inp.btcUsd) return { usd: inp.btcUsd / inp.poolUsdPerSbtc, source: "sBTC/USDCx pool vs BTC/USD", fallback: true };
  return { usd: null, source: "none readable", fallback: true };
}

export interface ObserveResult { ran: boolean; record?: Record<string, unknown>; decision?: TrendDecision; alert?: string | null }

/**
 * One observe-mode step: refresh and cross-check the closes, and if today's decision is due, decide,
 * measure exit capacity and the pegs, persist the would-be state and return the journal record.
 * `capitalUsd` is the capital the mode would manage (the DLMM position, design 4.5), for sizing the
 * would-be switch against the measured capacity. `persist: false` reads and decides without writing
 * any file (the CLI's status view).
 */
export async function trendObserveStep(opts: { now?: Date; capitalUsd: number | null; owner?: string | null; persist?: boolean; force?: boolean; budgetMs?: number }): Promise<ObserveResult> {
  const now = opts.now ?? new Date();
  const check = budget(opts.budgetMs ?? envNum("TREND_STEP_BUDGET_MS", 60_000));
  const persist = opts.persist ?? true;
  const p = trendParams();
  const memLoad = loadTrendMemory(trendStatePath(), now);
  const closesLoad = loadCloses();
  if (!memLoad.ok || !closesLoad.ok) {
    const reason = [!memLoad.ok && memLoad.reason, !closesLoad.ok && closesLoad.reason].filter(Boolean).join("; ");
    return { ran: true, alert: `trend files unreadable (${reason}); no decision until a human checks them`, record: { type: "trend-observe", action: "no-decision", reason: `unreadable: ${reason}` } };
  }
  const due = opts.force ? { due: true, mem: memLoad.value } : decisionDue(now, memLoad.value, p.decisionHourUtc);
  if (!due.due) {
    if (persist && due.mem !== memLoad.value) atomicWrite(trendStatePath(), due.mem);
    return { ran: false };
  }

  try {
    return await observeDue(opts, now, p, due.mem, closesLoad.value, persist, check);
  } catch (e) {
    if (!(e instanceof OverBudget)) throw e;
    // Nothing was written; the memory still says undecided today, so the next cycle tries again.
    return { ran: true, alert: null, record: { type: "trend-observe", action: "no-decision", reason: `${e.message}; retrying next cycle` } };
  }
}

async function observeDue(
  opts: { capitalUsd: number | null; owner?: string | null }, now: Date, p: TrendParams, dueMem: TrendMemory,
  stored: Close[], persist: boolean, check: (stage: string) => void,
): Promise<ObserveResult> {
  const due = { mem: dueMem };
  check("start");
  // Closes: fetch enough for the window plus a margin, append-only merge, cross-check the new ones.
  const fetched = await fetchLlamaCloses(stored.length >= p.smaDays ? 7 : p.smaDays + 10, now).catch(() => [] as Close[]);
  const merged = mergeCloses(stored, fetched);
  check("close fetch");
  const v = await verify(merged.closes.slice(-(p.smaDays + 10)), p.closeAgreeBps, now, check);
  const kept = [...merged.closes.slice(0, -(p.smaDays + 10)), ...v.closes];

  const nowS = Math.floor(now.getTime() / 1000);
  const btcSpotUsd = await llamaCurrent("coingecko:bitcoin", 900, nowS);
  const llamaUsdcx = await llamaCurrent("stacks:SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx", 3600, nowS);
  const stxUsd = await llamaCurrent("coingecko:blockstack", 900, nowS);
  check("price reads");
  const usdcxPerStx = await stxPoolUsdcxPerStx();
  check("STX/USDCx pool read");
  let pool: PoolRead | null = null, poolError: string | null = null;
  try { pool = await readSellSide(btcSpotUsd, p, opts.owner ?? null, check); } catch (e) {
    if (e instanceof OverBudget) throw e;
    poolError = (e as Error).message;
  }
  const usdcx = pickUsdcx({ stxUsd, usdcxPerStx, llamaUsdcx, poolUsdPerSbtc: pool?.usdPerSbtc ?? null, btcUsd: btcSpotUsd });
  const usdcxUsd = usdcx.usd;

  const src: TrendSources = { btcSpotUsd, poolUsdPerSbtc: pool?.usdPerSbtc ?? null, usdcxUsd, usdcxSource: usdcx.source };
  const d = decideTrend(kept, due.mem, src, p, now);
  const mem = nextMemory(due.mem, d, now);

  let capacity: Record<string, unknown> = { error: poolError ?? "no BTC/USD reference" };
  if (pool && Number.isFinite(pool.refYperX)) {
    const c = exitCapacity(pool.bins, pool.feeBps, pool.refYperX, p.exitMinOutBps);
    const sbtc = c.xIn / 1e8, usd = c.yOut / 1e6;
    const switchUsd = opts.capitalUsd && opts.capitalUsd > 0 ? opts.capitalUsd * p.riskShare : null;
    capacity = {
      minOutBps: p.exitMinOutBps, feeBps: pool.feeBps, excludesOwn: !!opts.owner, sbtc, usd: Math.round(usd), binsUsed: c.binsUsed, stoppedBy: c.stoppedBy,
      ...(switchUsd ? { wouldSellUsd: Math.round(switchUsd), coverage: Number((usd / switchUsd).toFixed(2)) } : {}),
    };
  }

  const alerts = [
    d.alert,
    merged.corrections.length ? `source changed ${merged.corrections.length} stored close(s); not applied` : null,
    v.newlyFailed.length ? `close(s) failed the exchange check: ${v.newlyFailed.join("; ")}. Check and, if right, mark: npm run m1:trend -- mark-checked <day>` : null,
    usdcx.fallback ? `USDCx price from fallback (${usdcx.source})` : null,
  ].filter(Boolean) as string[];
  const record = {
    type: "trend-observe", mode: "observe",
    action: d.action, from: due.mem.state, state: d.state, reason: d.reason,
    close: d.close, sma: d.sma && Math.round(d.sma), offLine: d.offLine && Math.round(d.offLine), onLine: d.onLine && Math.round(d.onLine),
    checks: d.checks, btcSpotUsd, usdcxUsd, usdcxSources: { used: usdcx.source, stxPool: stxUsd && usdcxPerStx ? stxUsd / usdcxPerStx : null, defillama: llamaUsdcx }, poolUsdPerSbtc: pool?.usdPerSbtc ?? null,
    exitCapacity: capacity, closesStored: kept.length, closesVerified: kept.filter((c) => c.verified).length,
    ...(merged.corrections.length ? { corrections: merged.corrections } : {}),
    noDecisionStreak: mem.noDecisionStreak, halted: mem.halted,
    ...(alerts.length ? { alert: alerts.join("; ") } : {}),
  };
  check("persist");
  if (persist) {
    atomicWrite(trendClosesPath(), { v: 1, closes: kept });
    atomicWrite(trendStatePath(), mem);
  }
  return { ran: true, record, decision: d, alert: alerts.length ? alerts.join("; ") : null };
}
