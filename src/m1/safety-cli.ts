// Standalone safety check: shows the oracle-sanity + kill-switch assessment for
// the sBTC-STX pool right now. Read-only, no trading.
//
//   npm run m1:safety

import { getPoolState } from "../pool.js";
import { getExternalMid, assessSafety, defaultSafetyParams } from "./safety.js";

const POOL_ID = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1";

async function main() {
  console.log("=== DeepStack — safety check (oracle-sanity + kill-switch) ===\n");
  const [pool, ext] = await Promise.all([getPoolState(POOL_ID), getExternalMid()]);
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

  console.log(`pool mid:     ${pool.midXinY.toLocaleString()} STX/sBTC  (pool-status: ${pool.poolActive ? "active" : "PAUSED"})`);
  console.log(
    `external mid: ${ext ? `${ext.midXinY.toLocaleString()} STX/sBTC  (BTC $${ext.btcUsd.toLocaleString()} / STX $${ext.stxUsd})` : "UNAVAILABLE"}`,
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
