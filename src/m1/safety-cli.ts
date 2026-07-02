// Standalone safety check: shows the oracle-sanity + kill-switch assessment for
// the active pair right now (PAIR env, default sbtc-stx). Read-only, no trading.
//
//   npm run m1:safety
//   PAIR=stx-aeusdc npm run m1:safety

import { getPoolState } from "../pool.js";
import { activePool, contractId } from "./contracts.js";
import { getExternalMid, assessSafety, defaultSafetyParams } from "./safety.js";

async function main() {
  const cfg = activePool();
  const { x, y } = cfg;
  console.log(`=== DeepStack — safety check [${cfg.poolSymbol}] (oracle-sanity + kill-switch) ===\n`);
  const [pool, ext] = await Promise.all([getPoolState(contractId(cfg.pool)), getExternalMid()]);
  const params = defaultSafetyParams();
  const res = assessSafety(
    {
      poolMid: pool.midXinY,
      externalMid: ext?.midXinY ?? null,
      poolActive: pool.poolActive,
      portfolioStx: 1,
      sessionStartStx: 1, // no session context in the standalone check
    },
    params,
  );

  console.log(`pool mid:     ${pool.midXinY.toLocaleString()} ${y.symbol}/${x.symbol}  (pool-status: ${pool.poolActive ? "active" : "PAUSED"})`);
  console.log(
    `external mid: ${ext ? `${ext.midXinY.toLocaleString()} ${y.symbol}/${x.symbol}  (${x.symbol} $${ext.xUsd.toLocaleString()} / ${y.symbol} $${ext.yUsd})` : "UNAVAILABLE"}`,
  );
  console.log(
    `divergence:   ${res.divergenceBps != null ? `${(res.divergenceBps / 100).toFixed(2)}%` : "n/a"}  (band ${(params.maxDivergenceBps / 100).toFixed(2)}%)`,
  );
  console.log(`\n${res.safe ? "✅ SAFE to trade" : "⛔ HALT — " + res.reasons.join("; ")}`);
}

main().catch((e) => {
  console.error("safety check failed:", e.message);
  process.exit(1);
});
