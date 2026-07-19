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

const SBTC = "sbtc-token";

/** Pure parser so the fixture-based tests never need the network. */
export function parseCrossPools(ticker: unknown): CrossPoolObs[] {
  if (!Array.isArray(ticker)) return [];
  const out: CrossPoolObs[] = [];
  for (const t of ticker) {
    const id = String((t as any)?.ticker_id ?? "");
    if (!id.toLowerCase().includes(SBTC)) continue;
    const price = Number((t as any)?.last_price);
    const liqUsd = Number((t as any)?.liquidity_in_usd);
    if (!(liqUsd > 0)) continue;
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
