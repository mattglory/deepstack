// Oracle-sanity + kill-switch — the venue-agnostic safety layer.
//
// Lesson from the Velar PerpDEX exploit (Feb 2026): a venue's price can be
// manipulated during thin volume, and a venue may lack its own pause. DeepStack
// therefore NEVER trusts a venue's price or solvency blindly. Before any trade:
//   1. cross-check the on-chain AMM mid against an INDEPENDENT reference,
//   2. refuse to trade if they diverge beyond a band (possible manipulation),
//   3. honour venue pause flags, drawdown limits, and a manual kill-switch.
// Fail-closed: if the external reference is missing, do not trade.

import { existsSync } from "node:fs";
import { activePool } from "./contracts.js";

export interface ExternalMid {
  xUsd: number;
  yUsd: number;
  midXinY: number; // implied y per x = xUsd / yUsd
}

// Independent reference price (CoinGecko, public, no key) for the active pair's
// two tokens. Returns null on failure. Fail-closed handling lives in assessSafety.
export async function getExternalMid(): Promise<ExternalMid | null> {
  try {
    const p = activePool();
    const ids = [p.x.coingecko, p.y.coingecko];
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`,
    );
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, { usd?: number }>;
    const xUsd = Number(j[p.x.coingecko]?.usd);
    const yUsd = Number(j[p.y.coingecko]?.usd);
    if (!(xUsd > 0 && yUsd > 0)) return null;
    return { xUsd, yUsd, midXinY: xUsd / yUsd };
  } catch {
    return null;
  }
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

  if (process.env.KILL_SWITCH === "1" || existsSync("KILL")) {
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
