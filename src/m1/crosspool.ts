// Cross-pool spread scanner — the data that decides whether atomic arb is worth building.
//
// Route B of divergence capture (docs/FLASH_REBALANCE.md) is a flash-borrowed round trip
// across two venues in one transaction. It only pays when the POOL-VS-POOL spread beats
// both pools' fees (~1.05% total) — a question our pool-vs-CEX detector can't answer.
// This scanner reads every sBTC pool on Bitflow's public ticker each cycle and journals
// the observations; by pilot end the journal says how often, and how far, cross-venue
// spreads actually open. Data first, executor only if the data votes yes.
//
// Read-only, off the hot path, never throws — a dead ticker API costs one journal line.

import { config } from "../config.js";

export interface CrossPoolObs {
  pool: string; // short venue id (last contract segment)
  price: number; // venue's last price (base per target as the ticker reports it)
  liqUsd: number;
}

// Record every pool deep enough to route through (not just sBTC pairs): closable arb
// cycles live in the whole graph — the fattest one found so far is the SAME-PAIR
// STX/stSTX multi-pool group, whose price gaps this series will measure over the pilot.
const MIN_LIQ_USD = 5_000;

/** Pure parser so the fixture-based tests never need the network. */
export function parseCrossPools(ticker: unknown): CrossPoolObs[] {
  if (!Array.isArray(ticker)) return [];
  const out: CrossPoolObs[] = [];
  for (const t of ticker) {
    const id = String((t as any)?.ticker_id ?? "");
    if (!id) continue;
    const price = Number((t as any)?.last_price);
    const liqUsd = Number((t as any)?.liquidity_in_usd);
    if (!(liqUsd >= MIN_LIQ_USD)) continue;
    const short = id
      .split("_")
      .map((p) => p.split(".").pop())
      .join("/");
    out.push({ pool: short, price: Number.isFinite(price) ? price : 0, liqUsd: Math.round(liqUsd) });
  }
  return out;
}

export async function scanCrossPools(): Promise<CrossPoolObs[]> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const r = await fetch(`${config.bitflowTickerApi}/ticker`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    return parseCrossPools(await r.json());
  } catch {
    return []; // telemetry, not safety-critical
  }
}
