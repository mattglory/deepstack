// PoC spike entry point.
//
// Demonstrates, end to end, the read-and-decide loop the live agent is built on:
//   1. Pull LIVE Bitflow pools (real liquidity/price data, no API key).
//   2. Surface the BTC-flavoured pools — our thesis target (idle sBTC needs depth).
//   3. Introspect a pool's Clarity contract on-chain (list its read-only fns,
//      and call a no-arg reader if one exists) — proving on-chain capability.
//   4. Run the deterministic MM core to emit a concrete quote + LP range.
//
// Run: npm install && npm run spike

import { config } from "./config.js";
import {
  fetchTickers,
  topPoolsByLiquidity,
  filterByHints,
  type Ticker,
} from "./bitflow.js";
import { getReadOnlyFunctions } from "./stacks.js";
import { getPoolState } from "./pool.js";
import { computeQuote } from "./mm.js";
import { BTC_HINTS } from "./config.js";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main() {
  console.log("=== Stacks Liquidity Agent — PoC spike ===\n");

  // 1. LIVE pools
  const tickers = await fetchTickers();
  console.log(`Fetched ${tickers.length} live Bitflow pools.\n`);

  // 2. Top pools + BTC-flavoured subset (the thesis target)
  console.log("Top pools by USD liquidity:");
  for (const t of topPoolsByLiquidity(tickers)) {
    console.log(`  ${usd(t.liquidity_in_usd).padStart(14)}  ${t.ticker_id}`);
  }

  const btcPools = filterByHints(tickers, BTC_HINTS).sort(
    (a, b) => b.liquidity_in_usd - a.liquidity_in_usd,
  );
  console.log(`\nBTC-flavoured pools (our target): ${btcPools.length}`);
  for (const t of btcPools) {
    console.log(`  ${usd(t.liquidity_in_usd).padStart(14)}  ${t.pool_id}`);
  }

  // 3. On-chain reserves of the deepest target pool (mid from constant-product)
  const target: Ticker | undefined = btcPools[0] ?? topPoolsByLiquidity(tickers)[0];
  let mid = 1.0;
  if (target) {
    console.log(`\nReading on-chain state: ${target.pool_id}`);
    try {
      const readers = await getReadOnlyFunctions(target.pool_id);
      console.log(`  read-only fns: ${readers.map((f) => f.name).join(", ")}`);

      const pool = await getPoolState(target.pool_id);
      mid = pool.midXinY;
      const sym = pool.poolSymbol.split("-");
      const xSym = sym[0] ?? "X";
      const ySym = sym[1] ?? "Y";
      console.log(`  pool ${pool.poolSymbol}  (fee ${pool.feeBps} bps)`);
      console.log(`  reserves: ${pool.xReserve.toLocaleString()} ${xSym}  +  ${pool.yReserve.toLocaleString()} ${ySym}`);
      console.log(`  AMM mid (on-chain): 1 ${xSym} = ${mid.toLocaleString()} ${ySym}`);
    } catch (err) {
      console.log(`  (on-chain read skipped: ${(err as Error).message})`);
    }
  }

  // 4. Deterministic MM decision around the on-chain mid
  const quote = computeQuote({
    mid,
    spreadBps: config.targetSpreadBps,
    rangeBps: config.lpRangeBps,
  });
  console.log("\nDeterministic MM decision (params the AI layer would tune):");
  console.log(JSON.stringify(quote, null, 2));
}

main().catch((err) => {
  console.error("spike failed:", err);
  process.exit(1);
});
