// Guarded MAINNET smoke test — the first real validation of the receive-leg
// post-conditions against Bitflow's (mainnet-only) sBTC-STX pool.
//
// SAFETY RAILS:
//  - refuses unless STACKS_NETWORK=mainnet (the funded wallet)
//  - PREVIEW by default; only broadcasts with the explicit --yes-mainnet flag
//  - hard per-tx amount caps (rejects anything larger)
//  - Deny-mode post-conditions => a wrong assertion aborts the tx (lose only fee)
//
// Usage (preview):    npm run m1:smoke -- swap-y-for-x 5
// Usage (broadcast):  npm run m1:smoke -- swap-y-for-x 5 --yes-mainnet
//   swap-y-for-x <stx>   sell <stx> STX for sBTC   (cheapest: needs only STX)
//   swap-x-for-y <sbtc>  sell <sbtc> sBTC for STX

import { getWallet, getStxBalance } from "./wallet.js";
import { buildSwapYForX, buildSwapXForY, type BuiltTx } from "./actions.js";
import { SBTC, STX } from "./contracts.js";

// Hard ceilings — a smoke is meant to be tiny.
const CAP_STX_USTX = 25_000_000n; // 25 STX
const CAP_SBTC_BASE = 50_000n; // 0.0005 sBTC
const FEE_USTX = 50_000n; // 0.05 STX

function parseArgs() {
  const a = process.argv.slice(2);
  const yes = a.includes("--yes-mainnet");
  const pos = a.filter((x) => !x.startsWith("--"));
  return { action: pos[0], amount: pos[1], yes };
}

async function main() {
  console.log("=== DeepStack M1 — MAINNET smoke ===\n");
  const { action, amount, yes } = parseArgs();

  if (!action || !amount) {
    throw new Error("usage: m1:smoke -- <swap-y-for-x|swap-x-for-y> <amount> [--yes-mainnet]");
  }
  const w = await getWallet();
  if (w.network !== "mainnet") {
    throw new Error(`refusing: STACKS_NETWORK is ${w.network}. Set it to mainnet for a real smoke.`);
  }
  const amt = Number(amount);
  if (!(amt > 0)) throw new Error(`bad amount: ${amount}`);

  console.log(`network: mainnet\naddress: ${w.address}`);
  const bal = await getStxBalance(w.address, w.network);
  console.log(`STX balance: ${bal.stx} STX\n`);

  let built: BuiltTx;
  const opts = {
    senderKey: w.key,
    network: "mainnet" as const,
    broadcast: yes,
    feeMicroStx: FEE_USTX,
  };

  if (action === "swap-y-for-x") {
    const yAmount = BigInt(Math.round(amt * 10 ** STX.decimals));
    if (yAmount > CAP_STX_USTX) throw new Error(`amount exceeds cap (${CAP_STX_USTX} uSTX)`);
    if (bal.microStx < yAmount + FEE_USTX)
      throw new Error("insufficient STX for amount + fee");
    built = await buildSwapYForX(yAmount, opts);
  } else if (action === "swap-x-for-y") {
    const xAmount = BigInt(Math.round(amt * 10 ** SBTC.decimals));
    if (xAmount > CAP_SBTC_BASE) throw new Error(`amount exceeds cap (${CAP_SBTC_BASE} base sBTC)`);
    if (bal.microStx < FEE_USTX) throw new Error("insufficient STX for fee");
    built = await buildSwapXForY(xAmount, opts);
  } else {
    throw new Error(`unknown action: ${action}`);
  }

  console.log(`action: ${built.action}`);
  console.log("details:");
  for (const [k, v] of Object.entries(built.details)) console.log(`  ${k}: ${v}`);
  console.log("post-conditions (input caps; receive bounded on-chain by min-*):");
  for (const pc of built.postConditions) console.log(`  - ${pc}`);

  if (!yes) {
    console.log("\n⚠ PREVIEW ONLY — nothing broadcast.");
    console.log("  Re-run with --yes-mainnet to broadcast this real mainnet transaction.");
    return;
  }
  if (built.broadcast?.txid) {
    console.log(`\n✓ BROADCAST. txid: ${built.broadcast.txid}`);
    console.log(`  explorer: https://explorer.hiro.so/txid/${built.broadcast.txid}?chain=mainnet`);
  } else {
    console.log(`\n✗ broadcast did not return a txid: ${built.broadcast?.error}`);
    console.log("  (Deny mode fails closed — if a post-condition was wrong, the tx aborted safely.)");
  }
}

main().catch((err) => {
  console.error("smoke failed:", err.message);
  process.exit(1);
});
