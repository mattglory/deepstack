// Reads LIVE pool data from Bitflow's public ticker API (no key required).
// This gives us real on-chain liquidity/price data to seed quoting decisions.

import { config } from "./config.js";

export interface Ticker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  pool_id: string;
  liquidity_in_usd: number;
  last_price: number;
  base_volume: number;
  target_volume: number;
}

export async function fetchTickers(): Promise<Ticker[]> {
  const url = `${config.bitflowTickerApi}/ticker`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Bitflow ticker fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as Ticker[];
  // Defensive: coerce numeric fields (API returns numbers, but be safe).
  return data.map((t) => ({
    ...t,
    liquidity_in_usd: Number(t.liquidity_in_usd) || 0,
    last_price: Number(t.last_price) || 0,
    base_volume: Number(t.base_volume) || 0,
    target_volume: Number(t.target_volume) || 0,
  }));
}

// Rank pools by USD liquidity — where a market maker can do the most good.
export function topPoolsByLiquidity(tickers: Ticker[], n = 8): Ticker[] {
  return [...tickers]
    .sort((a, b) => b.liquidity_in_usd - a.liquidity_in_usd)
    .slice(0, n);
}

// Find pools that touch a BTC-flavoured asset (our thesis: idle sBTC needs depth).
export function filterByHints(tickers: Ticker[], hints: string[]): Ticker[] {
  const has = (s: string) => hints.some((h) => s.toLowerCase().includes(h));
  return tickers.filter(
    (t) => has(t.ticker_id) || has(t.base_currency) || has(t.target_currency),
  );
}
