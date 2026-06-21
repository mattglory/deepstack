// M1 dry-run demo: build (but DO NOT broadcast) an add-liquidity transaction
// for the sBTC-STX pool, showing the live quote, slippage-guarded min/max, and
// the exact post-conditions. No real key, no funds, nothing hits mainnet.
//
// Run: npm run m1:dryrun

import { buildAddLiquidity } from "./actions.js";

async function main() {
  console.log("=== DeepStack M1 — add-liquidity DRY RUN (no broadcast) ===\n");

  const xAmount = 100_000n; // 0.001 sBTC (8 dp)
  const built = await buildAddLiquidity(xAmount, { slippageBps: 100 });

  console.log(`action:   ${built.action}`);
  console.log(`mode:     ${built.dryRun ? "DRY RUN (ephemeral key, not broadcast)" : "LIVE"}`);
  console.log(`sender:   ${built.sender}`);
  console.log("\ndetails:");
  for (const [k, v] of Object.entries(built.details)) console.log(`  ${k}: ${v}`);
  console.log("\npost-conditions (Deny mode):");
  for (const pc of built.postConditions) console.log(`  - ${pc}`);
  console.log(`\nserialized tx (${built.serializedTx.length / 2} bytes), first 80 hex chars:`);
  console.log(`  ${built.serializedTx.slice(0, 80)}…`);
  console.log("\n✓ built and signed locally; NOT broadcast. Wire a funded testnet key next.");
}

main().catch((err) => {
  console.error("dry run failed:", err);
  process.exit(1);
});
