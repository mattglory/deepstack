// Oracle-sanity + kill-switch — the venue-agnostic safety layer.
//
// Lesson from the Velar PerpDEX exploit (Feb 2026): a venue's price can be
// manipulated during thin volume, and a venue may lack its own pause. DeepStack
// therefore NEVER trusts a venue's price or solvency blindly. Before any trade:
//   1. cross-check the on-chain AMM mid against an INDEPENDENT reference,
//   2. refuse to trade if they diverge beyond a band (possible manipulation),
//   3. honour venue pause flags, drawdown limits, and a manual kill-switch.
// Fail-closed: if the external reference is missing, stale, or its two sources disagree, do
// not trade.

import { isKilled } from "./kill.js";
import { activePool } from "./contracts.js";
import { appendJournal } from "./journal.js";

export interface ExternalMid {
  xUsd: number;
  yUsd: number;
  midXinY: number; // implied y per x = xUsd / yUsd
}

// Independent reference price for the active pair's two tokens, from TWO sources (C5 / DSA-11).
// Returns null, and the caller fails closed (assessSafety), unless both sources answered with
// fresh prices that agree:
//
//   - staleness: each source's own timestamp (CoinGecko last_updated_at, DefiLlama timestamp)
//     must be within EXTERNAL_PRICE_MAX_AGE_SECS (default 900 = 15 min). Both normally update
//     every 1-5 minutes; 15 min is several missed updates, not jitter, while a quarter hour is
//     still short against the 5% divergence band for BTC/STX. Before, the CoinGecko price had
//     no age check at all, so a frozen cache passed as live.
//   - agreement: the two implied mids must be within EXTERNAL_PRICE_MAX_SOURCE_DIVERGENCE_BPS
//     (default 200 = 2%, well inside the 5% pool band) or there is no reference this cycle. When
//     they agree the reference is their mean (the median of two).
//   - one source down: no reference (fail closed). A second source only helps if a single bad or
//     unavailable source cannot set the price on its own; falling back to "whichever answered"
//     would hand that power back to whoever can block the other. Cost: uptime when either API
//     is unavailable (CoinGecko's anonymous tier 403s often, so set COINGECKO_API_KEY).
//
// Every rejection is journalled (type "oracle-reject") as well as logged.
//
// Independence caveat: DefiLlama is separate infrastructure with its own caching, so it catches
// a stale, broken or tampered CoinGecko response path, but for coingecko:-keyed assets its
// upstream data may itself include CoinGecko. It is not an exchange-level second opinion.
//
// COINGECKO_API_KEY is optional but strongly recommended: the unauthenticated public
// endpoint shares one rate-limit pool across every anonymous caller globally, not per
// IP, and this agent has been hitting sustained HTTP 403s from it (2026-09-29 — 16 of
// 29 cycles in one day, each correctly fail-closing but costing real uptime). The free
// Demo plan (no credit card) raises this to a per-key limit. Header, not query param,
// per CoinGecko's own security recommendation — same reasoning as hiroHeaders() in
// rpc.ts for the equivalent Hiro rate-limit fix.

/** One source's answer: USD prices and the OLDER of the two tokens' update times (unix s). */
export interface SourcePrice { xUsd: number; yUsd: number; t: number }

export interface OracleParams {
  maxAgeSecs: number;
  maxSourceDivergenceBps: number;
}

export function oracleParams(): OracleParams {
  return {
    maxAgeSecs: envNumber("EXTERNAL_PRICE_MAX_AGE_SECS", 900),
    maxSourceDivergenceBps: envNumber("EXTERNAL_PRICE_MAX_SOURCE_DIVERGENCE_BPS", 200),
  };
}

function envNumber(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!(n > 0)) throw new Error(`${name} must be a positive number (got '${raw}')`);
  return n;
}

/** Throws unless `t` (unix seconds) is a real timestamp no older than the bound. */
export function assertFresh(t: number, what: string, nowSecs = Date.now() / 1000, maxAgeSecs = oracleParams().maxAgeSecs): void {
  if (!(t > 0)) throw new Error(`${what}: no update timestamp`);
  const age = nowSecs - t;
  if (age > maxAgeSecs) throw new Error(`${what}: stale (${Math.round(age)}s old > ${maxAgeSecs}s)`);
}

export type Combined = { ok: true; mid: ExternalMid; divergenceBps: number } | { ok: false; reason: string };

/**
 * Combine the two sources' answers (or the reason each failed) into one reference. Pure.
 * Fails closed on: either source missing, either stale, or the two disagreeing beyond the bound.
 */
export function combineReferences(
  a: SourcePrice | string,
  b: SourcePrice | string,
  nowSecs: number,
  params: OracleParams = oracleParams(),
  names: [string, string] = ["coingecko", "defillama"],
): Combined {
  const srcs: [string, SourcePrice | string][] = [[names[0], a], [names[1], b]];
  for (const [name, s] of srcs) {
    if (typeof s === "string") return { ok: false, reason: `${name} unavailable: ${s}` };
    if (!(s.xUsd > 0 && s.yUsd > 0)) return { ok: false, reason: `${name} returned no usable price` };
    try {
      assertFresh(s.t, name, nowSecs, params.maxAgeSecs);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }
  const pa = a as SourcePrice, pb = b as SourcePrice;
  const ma = pa.xUsd / pa.yUsd, mb = pb.xUsd / pb.yUsd;
  const mean = (ma + mb) / 2;
  const divergenceBps = Math.round((Math.abs(ma - mb) / mean) * 10_000);
  if (divergenceBps > params.maxSourceDivergenceBps) {
    return { ok: false, reason: `reference sources disagree by ${divergenceBps}bps > ${params.maxSourceDivergenceBps}bps (${names[0]} ${ma}, ${names[1]} ${mb})` };
  }
  const xUsd = (pa.xUsd + pb.xUsd) / 2, yUsd = (pa.yUsd + pb.yUsd) / 2;
  return { ok: true, mid: { xUsd, yUsd, midXinY: mean }, divergenceBps };
}

async function fromCoinGecko(xId: string, yId: string): Promise<SourcePrice | string> {
  try {
    const key = process.env.COINGECKO_API_KEY;
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${xId},${yId}&vs_currencies=usd&include_last_updated_at=true`,
      { headers: key ? { "x-cg-demo-api-key": key } : undefined, signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return `HTTP ${r.status}`;
    const j = (await r.json()) as Record<string, { usd?: number; last_updated_at?: number }>;
    return { xUsd: Number(j[xId]?.usd), yUsd: Number(j[yId]?.usd), t: Math.min(Number(j[xId]?.last_updated_at), Number(j[yId]?.last_updated_at)) };
  } catch (err) {
    return (err as Error).message;
  }
}

async function fromDefiLlama(xId: string, yId: string): Promise<SourcePrice | string> {
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/coingecko:${xId},coingecko:${yId}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return `HTTP ${r.status}`;
    const j = (await r.json()) as { coins?: Record<string, { price?: number; timestamp?: number }> };
    const x = j.coins?.[`coingecko:${xId}`], y = j.coins?.[`coingecko:${yId}`];
    return { xUsd: Number(x?.price), yUsd: Number(y?.price), t: Math.min(Number(x?.timestamp), Number(y?.timestamp)) };
  } catch (err) {
    return (err as Error).message;
  }
}

export async function getExternalMid(): Promise<ExternalMid | null> {
  const p = activePool();
  const [cg, ll] = await Promise.all([fromCoinGecko(p.x.coingecko, p.y.coingecko), fromDefiLlama(p.x.coingecko, p.y.coingecko)]);
  let c: Combined;
  try {
    c = combineReferences(cg, ll, Date.now() / 1000);
  } catch (err) {
    c = { ok: false, reason: (err as Error).message }; // a malformed env bound: fail closed
  }
  if (c.ok) return c.mid;
  console.warn(`(external price unavailable: ${c.reason})`);
  appendJournal({ t: new Date().toISOString(), type: "oracle-reject", reason: c.reason, coingecko: cg, defillama: ll });
  return null;
}

export interface SafetyParams {
  maxDivergenceBps: number; // pool-vs-external mid divergence before halting
  maxDrawdownBps: number; // session drawdown before halting
  requireExternal: boolean; // fail-closed if no external reference
}

export function defaultSafetyParams(): SafetyParams {
  return { maxDivergenceBps: 500, maxDrawdownBps: 1500, requireExternal: true };
}

export interface SafetyInput {
  poolMid: number; // on-chain AMM mid (STX per sBTC)
  externalMid: number | null; // independent reference mid
  poolActive: boolean; // venue pool-status
  portfolioStx: number;
  sessionStartStx: number;
}

export interface SafetyResult {
  safe: boolean;
  reasons: string[]; // why it is NOT safe (empty when safe)
  divergenceBps: number | null;
  drawdownBps: number;
}

export function assessSafety(input: SafetyInput, params: SafetyParams): SafetyResult {
  const reasons: string[] = [];

  if (isKilled()) {
    reasons.push("manual kill-switch engaged");
  }
  if (!input.poolActive) {
    reasons.push("venue pool is paused/disabled (pool-status=false)");
  }

  let divergenceBps: number | null = null;
  if (input.externalMid == null) {
    if (params.requireExternal) reasons.push("no external price reference (fail-closed)");
  } else {
    divergenceBps = Math.round(
      (Math.abs(input.poolMid - input.externalMid) / input.externalMid) * 10_000,
    );
    if (divergenceBps > params.maxDivergenceBps) {
      reasons.push(
        `price divergence ${(divergenceBps / 100).toFixed(2)}% > ${(params.maxDivergenceBps / 100).toFixed(2)}% band (possible manipulation)`,
      );
    }
  }

  const drawdownBps =
    input.sessionStartStx > 0
      ? Math.max(
          0,
          Math.round(((input.sessionStartStx - input.portfolioStx) / input.sessionStartStx) * 10_000),
        )
      : 0;
  if (drawdownBps > params.maxDrawdownBps) {
    reasons.push(
      `session drawdown ${(drawdownBps / 100).toFixed(2)}% > ${(params.maxDrawdownBps / 100).toFixed(2)}% limit`,
    );
  }

  return { safe: reasons.length === 0, reasons, divergenceBps, drawdownBps };
}
