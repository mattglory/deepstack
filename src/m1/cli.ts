// M1 dry-run demo: build (but DO NOT broadcast) add-liquidity, swap, and
// withdraw-liquidity transactions for the sBTC-STX pool — showing live quotes,
// slippage-guarded bounds, and exact post-conditions. No real key, no funds,
// nothing hits mainnet.
//
// Run: npm run m1:dryrun

import {
  buildAddLiquidity,
  buildSwapXForY,
  buildWithdrawLiquidity,
  type BuiltTx,
} from "./actions.js";

function print(b: BuiltTx) {
  console.log(`\n── ${b.action} ──`);
  console.log(`mode:   ${b.dryRun ? "DRY RUN (ephemeral key, not broadcast)" : "LIVE"}`);
  console.log(`sender: ${b.sender}`);
  console.log("details:");
  for (const [k, v] of Object.entries(b.details)) console.log(`  ${k}: ${v}`);
  console.log("post-conditions (Deny mode):");
  for (const pc of b.postConditions) console.log(`  - ${pc}`);
  console.log(`serialized: ${b.serializedTx.length / 2} bytes (${b.serializedTx.slice(0, 48)}…)`);
}

async function main() {
  console.log("=== DeepStack M1 — write-side DRY RUN (no broadcast) ===");

  print(await buildAddLiquidity(100_000n)); // 0.001 sBTC
  print(await buildSwapXForY(100_000n)); // sell 0.001 sBTC for STX
  print(await buildWithdrawLiquidity(1_000_000n)); // burn 1.0 LP

  console.log("\n✓ all built and signed locally; NOTHING broadcast.");
  console.log("  Next: wire a funded TESTNET key and broadcast on testnet to confirm");
  console.log("  the receive-leg post-conditions (marked 'verify on testnet').");
}

main().catch((err) => {
  console.error("dry run failed:", err);
  process.exit(1);
});
