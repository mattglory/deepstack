// Capital-preservation mode, observe only: the reads and the files around trend.ts.
//
// Sources (design 4.1, 4.3, 4.4):
//   - daily BTC/USD closes: DefiLlama chart/coingecko:bitcoin period 1d, the series the backtest
//     used. Its daily point is a snapshot at a fixed time of day (about 08:17 UTC), not a midnight
//     close; each is cross-checked against the Coinbase BTC-USD hourly candle containing it.
//   - BTC/USD now: DefiLlama current price (at most 15 minutes old).
//   - USDCx/USD: DefiLlama's on-chain price for the Stacks USDCx token (at most 1 hour old).
//   - the sBTC/USDCx HODLMM pool: active-bin price, fee and the bins below it (pinned tokens).
// Files (atomic writes; an unreadable file means no decision and an alert, never a silent reset):
//   journal/trend-closes.json  append-only close history
//   journal/trend-state.json   the would-be state, switch log and today's decision minute
// Nothing here signs or broadcasts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DLMM_POOLS, pinMismatch, readBinLiquidityStates, readDlmmState } from "./dlmm-read.js";
import {
  closeAgrees, decideTrend, decisionDue, exitCapacity, freshMemory, isTrendMemory, mergeCloses, nextMemory,
  type Close, type TrendDecision, type TrendMemory, type TrendParams, type TrendSources, type SellBin, defaultTrendParams,
} from "./trend.js";

const TIMEOUT_MS = 10_000;
const MAX_SELL_BINS = 40;

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
  const start = Math.floor(now.getTime() / 1000) - days * 86_400;
  const j = await getJson(`https://coins.llama.fi/chart/coingecko:bitcoin?start=${start}&span=${days + 1}&period=1d`);
  const pts: { timestamp: number; price: number }[] = j?.coins?.["coingecko:bitcoin"]?.prices ?? [];
  const today = now.toISOString().slice(0, 10);
  const byDay = new Map<string, Close>();
  for (const x of pts) {
    if (!(x.price > 0) || !(x.timestamp > 0)) continue;
    const day = new Date(x.timestamp * 1000).toISOString().slice(0, 10);
    if (day >= today) continue; // today's point is still being revised; only completed days are stored
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

/** Cross-check each close that isn't verified yet (new ones, and earlier ones whose check failed). */
async function verify(closes: Close[], agreeBps: number): Promise<Close[]> {
  const out: Close[] = [];
  for (const c of closes) {
    if (c.verified) { out.push(c); continue; }
    try {
      const r = closeAgrees(c.price, await fetchExchangeHour(c.t), agreeBps);
      out.push({ ...c, verified: r.ok, check: r.check });
    } catch (e) {
      out.push({ ...c, verified: false, check: `exchange unreadable: ${(e as Error).message}` });
    }
  }
  return out;
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
 *  first bin below the exit floor (or MAX_SELL_BINS). Pinned tokens and core, or it throws. */
async function readSellSide(btcSpotUsd: number | null, p: TrendParams): Promise<PoolRead> {
  const pool = DLMM_POOLS.find((x) => x.key === "sbtc-usdcx")!;
  const st = await readDlmmState(pool);
  if (!st) throw new Error("sbtc-usdcx pool unreadable");
  const bad = pinMismatch(pool, st);
  if (bad) throw new Error(`pin mismatch: ${bad}`);
  const feeBps = st.swapFeeBps;
  if (!(feeBps !== undefined && feeBps >= 0 && feeBps < 10_000)) throw new Error("pool fee unreadable");
  const scale = 10 ** (pool.pin.xDecimals - pool.pin.yDecimals); // base-unit price -> USDCx per sBTC
  const ref = btcSpotUsd ?? null;
  const bins: SellBin[] = [];
  let usdPerSbtc = NaN;
  for (let k = 0; k < MAX_SELL_BINS; k++) {
    const id = st.activeBinId - k;
    const s = (await readBinLiquidityStates(pool, st.coreAddress, st.initialPrice, st.binStep, [id])).get(id)!;
    if (k === 0) usdPerSbtc = (Number(s.binPrice) / 1e8) * scale;
    bins.push({ binId: id, yBalance: s.yBalance, binPrice: s.binPrice });
    if (ref === null) break; // no reference: price only, no capacity walk
    const pNet = (Number(s.binPrice) / 1e8) * scale * (1 - feeBps / 10_000);
    if (s.yBalance > 0n && pNet < ref * (1 - p.exitMinOutBps / 10_000)) break;
  }
  return { usdPerSbtc, feeBps, bins, refYperX: ref === null ? NaN : ref / scale };
}

export interface ObserveResult { ran: boolean; record?: Record<string, unknown>; decision?: TrendDecision; alert?: string | null }

/**
 * One observe-mode step: refresh and cross-check the closes, and if today's decision is due, decide,
 * measure exit capacity and the pegs, persist the would-be state and return the journal record.
 * `capitalUsd` is the capital the mode would manage (the DLMM position, design 4.5), for sizing the
 * would-be switch against the measured capacity. `persist: false` reads and decides without writing
 * any file (the CLI's status view).
 */
export async function trendObserveStep(opts: { now?: Date; capitalUsd: number | null; persist?: boolean; force?: boolean }): Promise<ObserveResult> {
  const now = opts.now ?? new Date();
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

  // Closes: fetch enough for the window plus a margin, append-only merge, cross-check the new ones.
  const stored = closesLoad.value;
  const fetched = await fetchLlamaCloses(stored.length >= p.smaDays ? 7 : p.smaDays + 10, now).catch(() => [] as Close[]);
  const merged = mergeCloses(stored, fetched);
  const closes = await verify(merged.closes.slice(-(p.smaDays + 10)), p.closeAgreeBps);
  const kept = [...merged.closes.slice(0, -(p.smaDays + 10)), ...closes];

  const nowS = Math.floor(now.getTime() / 1000);
  const btcSpotUsd = await llamaCurrent("coingecko:bitcoin", 900, nowS);
  const usdcxUsd = await llamaCurrent("stacks:SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx", 3600, nowS);
  let pool: PoolRead | null = null, poolError: string | null = null;
  try { pool = await readSellSide(btcSpotUsd, p); } catch (e) { poolError = (e as Error).message; }

  const src: TrendSources = { btcSpotUsd, poolUsdPerSbtc: pool?.usdPerSbtc ?? null, usdcxUsd };
  const d = decideTrend(kept, due.mem, src, p, now);
  const mem = nextMemory(due.mem, d, now);

  let capacity: Record<string, unknown> = { error: poolError ?? "no BTC/USD reference" };
  if (pool && Number.isFinite(pool.refYperX)) {
    const c = exitCapacity(pool.bins, pool.feeBps, pool.refYperX, p.exitMinOutBps);
    const sbtc = c.xIn / 1e8, usd = c.yOut / 1e6;
    const switchUsd = opts.capitalUsd && opts.capitalUsd > 0 ? opts.capitalUsd * p.riskShare : null;
    capacity = {
      minOutBps: p.exitMinOutBps, feeBps: pool.feeBps, sbtc, usd: Math.round(usd), binsUsed: c.binsUsed, stoppedBy: c.stoppedBy,
      ...(switchUsd ? { wouldSellUsd: Math.round(switchUsd), coverage: Number((usd / switchUsd).toFixed(2)) } : {}),
    };
  }

  const alerts = [d.alert, merged.corrections.length ? `source changed ${merged.corrections.length} stored close(s); not applied` : null].filter(Boolean) as string[];
  const record = {
    type: "trend-observe", mode: "observe",
    action: d.action, from: due.mem.state, state: d.state, reason: d.reason,
    close: d.close, sma: d.sma && Math.round(d.sma), offLine: d.offLine && Math.round(d.offLine), onLine: d.onLine && Math.round(d.onLine),
    checks: d.checks, btcSpotUsd, usdcxUsd, poolUsdPerSbtc: pool?.usdPerSbtc ?? null,
    exitCapacity: capacity, closesStored: kept.length, closesVerified: kept.filter((c) => c.verified).length,
    ...(merged.corrections.length ? { corrections: merged.corrections } : {}),
    noDecisionStreak: mem.noDecisionStreak, halted: mem.halted,
    ...(alerts.length ? { alert: alerts.join("; ") } : {}),
  };
  if (persist) {
    atomicWrite(trendClosesPath(), { v: 1, closes: kept });
    atomicWrite(trendStatePath(), mem);
  }
  return { ran: true, record, decision: d, alert: alerts.length ? alerts.join("; ") : null };
}
