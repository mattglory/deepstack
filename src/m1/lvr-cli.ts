// What does providing liquidity on this pool actually cost?
//
// Reads the agent's own mid history (dashboard/metrics.json) to measure realised
// volatility, applies the constant-product LVR closed form (sigma^2/8 of pool value per
// unit time — Milionis et al. 2022), and reports the number that decides whether LPing
// here is a business: the daily volume the POOL must trade for fee income to cover what
// arbitrageurs extract.
//
// Read-only. Broadcasts nothing, signs nothing.
//
// Usage: npm run m1:lvr

import { readFileSync, existsSync } from "node:fs";
import { activePool } from "./contracts.js";
import { getPoolRaw } from "./quotes.js";
import { estimateLvr, breakEvenDailyVolume, type MidPoint } from "./lvr.js";

const METRICS_PATH = process.env.METRICS_PATH ?? "dashboard/metrics.json";
const POOL_FEE_BPS = Number(process.env.POOL_FEE_BPS ?? 50); // Bitflow XYK: 0.5%

const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

async function main() {
  const { x, y, poolSymbol } = activePool();
  console.log(`=== DeepStack — LVR / LP economics [${poolSymbol}] ===\n`);

  if (!existsSync(METRICS_PATH)) throw new Error(`no metrics at ${METRICS_PATH} — run the agent first`);
  const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
  const points: MidPoint[] = (m.samples ?? []).map((s: any) => ({
    t: s.t,
    mid: s.mid,
    lpValueY: s.lpValueY ?? 0,
  }));

  const est = estimateLvr(points);
  if (est.sigmaDaily === null) {
    console.log("Not enough mid history to measure volatility yet. Run the agent for a while.");
    return;
  }

  // Pool value in y: both legs valued at the pool's own mid.
  const pool = await getPoolRaw();
  const xRes = Number(pool.xBalance) / 10 ** x.decimals;
  const yRes = Number(pool.yBalance) / 10 ** y.decimals;
  const mid = yRes / xRes;
  const poolValueY = yRes * 2; // constant-product pool is 50/50 by value
  const lastLp = points[points.length - 1]?.lpValueY ?? 0;

  console.log("measured from the agent's own mid history");
  console.log(`  window:            ${fmt(est.windowDays)} days over ${est.samples} intervals`);
  console.log(`  realised vol:      ${fmt(est.sigmaDaily * 100)}% / day (pool mid, ${x.symbol}/${y.symbol})`);
  console.log(`  pool mid:          ${fmt(mid, 0)} ${y.symbol} per ${x.symbol}`);
  console.log(`  pool value:        ${fmt(poolValueY, 0)} ${y.symbol}  (${fmt(xRes, 6)} ${x.symbol} + ${fmt(yRes, 0)} ${y.symbol})\n`);

  const rate = est.lvrRateBpsPerDay!;
  console.log("LVR — what arbitrageurs extract from LPs (sigma^2/8, CPMM closed form)");
  console.log(`  rate:              ${fmt(rate, 3)} bps/day of LP value`);
  console.log(`  pool-wide:         ${fmt((rate / 10_000) * poolValueY, 2)} ${y.symbol}/day`);
  console.log(`  on our LP:         ${fmt((rate / 10_000) * lastLp, 4)} ${y.symbol}/day  (LP = ${fmt(lastLp)} ${y.symbol})`);
  console.log(`  incurred to date:  ${fmt(est.cumulativeLvrY, 4)} ${y.symbol} over the window\n`);

  const beVolume = breakEvenDailyVolume(est.sigmaDaily, poolValueY, POOL_FEE_BPS);
  console.log(`break-even — the number that decides whether LPing here is a business`);
  console.log(`  pool fee:          ${POOL_FEE_BPS} bps`);
  console.log(`  volume needed:     ${fmt(beVolume, 0)} ${y.symbol}/day for fees to cover LVR`);
  console.log(`  = ${fmt((beVolume / poolValueY) * 100)}% of pool value turning over daily`);
  console.log(`\n  This is a property of the POOL, not of our position size: pool share cancels`);
  console.log(`  out of the equality, so it is the same bar for every LP in it.`);
  console.log(`  Above that volume, LPing earns. Below it, LPing loses to arbitrage no`);
  console.log(`  matter how well the position is managed.\n`);

  console.log("caveats (these matter):");
  console.log("  - sparse sampling under-estimates realised vol: moves that round-trip between");
  console.log("    heartbeats are invisible, so treat LVR as a LOWER bound and vol as a floor.");
  console.log("  - the closed form assumes continuous, frictionless arbitrage and GBM.");
  console.log("  - fee income is not measured here — compare against the pool's real volume.");
}

main().catch((err) => {
  console.error("lvr failed:", err.message);
  process.exit(1);
});
