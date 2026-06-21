// Read-only yield scan: where could DeepStack's idle inventory earn the best
// risk-adjusted yield on Stacks today? No funds move.
//
// Run: npm run yield

import { StacksLendingVenue } from "./stacksLending.js";

// Assets DeepStack actually holds as inventory and might park when idle.
const DEEPSTACK_ASSETS = ["sBTC", "STX", "USDC", "USDH"];

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

async function main() {
  console.log("=== DeepStack — idle-capital yield scan (Stacks-native, read-only) ===\n");

  const venue = new StacksLendingVenue();
  const all = await venue.listOpportunities({ minTvlUsd: 0 });
  console.log(`${venue.name} on ${venue.chain}: ${all.length} pools\n`);

  console.log("  asset      venue      base%   reward%   total%   risk    TVL          score");
  for (const o of all) {
    const row = [
      o.asset.padEnd(9),
      o.venue.padEnd(9),
      o.apyBase.toFixed(2).padStart(6),
      o.apyReward.toFixed(2).padStart(8),
      o.apyTotal.toFixed(2).padStart(8),
      o.riskScore.toFixed(2).padStart(6),
      usd(o.tvlUsd).padStart(12),
      o.score.toFixed(3).padStart(8),
    ].join("  ");
    console.log("  " + row);
  }

  // The DeepStack-relevant subset, best risk-adjusted first.
  const relevant = await venue.listOpportunities({
    assets: DEEPSTACK_ASSETS,
    minTvlUsd: 1_000_000,
  });
  const best = relevant[0];
  console.log(
    `\nBest idle-capital home for DeepStack assets (${DEEPSTACK_ASSETS.join(", ")}, TVL ≥ $1M):`,
  );
  if (best) {
    console.log(
      `  -> ${best.asset} on ${best.venue}: ${best.apyTotal.toFixed(2)}% total ` +
        `(risk ${best.riskScore.toFixed(2)}, TVL ${usd(best.tvlUsd)})`,
    );
  } else {
    console.log("  -> none above the TVL floor right now");
  }
}

main().catch((err) => {
  console.error("yield scan failed:", err);
  process.exit(1);
});
