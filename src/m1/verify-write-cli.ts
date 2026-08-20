// Post-fork write-path check — confirms the wallet → sign → serialize → broadcast → mine
// pipeline still works on MAINNET after the SIP-044 (Clarity 6) / SIP-045 hard fork.
//
// Why this exists: the last real broadcast was 2026-07-15, before the ~Jul 29 fork. Read
// paths clearly work post-fork (the agent reads every cycle), but signing + broadcast had
// not been exercised on Clarity 6. Rather than discover a serialization problem on a live
// rebalance, this proves the pipeline with the smallest, safest possible transaction: a
// 1-microSTX transfer to the wallet's OWN address. Only the fee is spent; the 1 µSTX
// returns to sender.
//
// SAFETY: mainnet-only (that's the point), PREVIEW by default, broadcasts only with the
// explicit --yes-mainnet flag, hard-capped amount, and it waits for confirmation so a
// "success" means the post-fork network actually MINED it — not just accepted it.
//
// Scope, stated honestly: this verifies the transaction transport (sign/serialize/
// broadcast/mine). It does NOT exercise a contract-call with post-conditions — Clarity 6
// leaves STX/FT post-condition serialization unchanged, so that path is very unlikely to
// break independently, but the definitive contract-call check is the next real rebalance
// or a tiny `m1:smoke` swap.
//
//   npm run m1:verify-write               (preview — broadcasts nothing)
//   npm run m1:verify-write -- --yes-mainnet

import { makeSTXTokenTransfer, broadcastTransaction, fetchNonce } from "@stacks/transactions";
import { withRpc, hiroFetch, hiroHeaders } from "./rpc.js";
import { getWallet, getStxBalance } from "./wallet.js";

const AMOUNT_USTX = 1n; // 1 microSTX, to self — the transfer itself costs nothing net
const FEE_USTX = 50_000n; // 0.05 STX — comfortably above any mempool minimum; one-off
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  return { yes: process.argv.slice(2).includes("--yes-mainnet") };
}

async function waitForConfirmation(txid: string) {
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const r = await fetch(`https://api.mainnet.hiro.so/extended/v1/tx/${txid}`, { headers: hiroHeaders("https://api.mainnet.hiro.so") });
    if (r.ok) {
      const j = (await r.json()) as { tx_status?: string };
      if (j.tx_status && j.tx_status !== "pending") return j.tx_status;
    }
  }
  return "timeout";
}

async function main() {
  console.log("=== DeepStack — post-fork MAINNET write-path check (SIP-044 / Clarity 6) ===\n");
  const { yes } = parseArgs();

  const w = await getWallet();
  if (w.network !== "mainnet") {
    throw new Error(`refusing: STACKS_NETWORK is ${w.network}. This check is mainnet-only (it verifies the mainnet post-fork write path).`);
  }
  console.log(`network: mainnet\naddress: ${w.address}`);

  const bal = await getStxBalance(w.address, w.network);
  console.log(`balance: ${bal.stx} STX`);
  if (bal.microStx < FEE_USTX + AMOUNT_USTX) {
    throw new Error(`insufficient STX for the fee (need ~${Number(FEE_USTX + AMOUNT_USTX) / 1e6}).`);
  }

  console.log("\naction: self-transfer");
  console.log(`  amount:    ${Number(AMOUNT_USTX) / 1e6} STX → self (returns to sender)`);
  console.log(`  fee:       ${Number(FEE_USTX) / 1e6} STX (the only real cost)`);
  console.log("  proves:    sign + serialize + broadcast + mine on the post-fork network");

  if (!yes) {
    console.log("\n⚠ PREVIEW ONLY — nothing broadcast.");
    console.log("  Re-run with --yes-mainnet to broadcast this real (tiny) mainnet transaction.");
    console.log("  Note: uses the agent wallet's nonce — run when the pilot agent isn't mid-broadcast.");
    return;
  }

  const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
  const tx = await makeSTXTokenTransfer({
    recipient: w.address, // to self
    amount: AMOUNT_USTX,
    senderKey: w.key,
    network: "mainnet",
    fee: FEE_USTX,
    nonce,
    memo: "deepstack post-fork write check",
  });

  const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
  const txid = (res as any).txid;
  if (!txid) {
    console.log("\n✗ broadcast rejected:", JSON.stringify(res));
    throw new Error("no txid returned — the post-fork network rejected the transaction (see response above)");
  }
  console.log(`\n✓ broadcast accepted. txid: ${txid}`);
  console.log(`  explorer: https://explorer.hiro.so/txid/${txid}?chain=mainnet`);
  console.log("  confirming (post-fork mining)…");

  const status = await waitForConfirmation(txid);
  console.log(`  status: ${status}`);
  if (status === "success") {
    console.log("\n✅ Post-fork write path CONFIRMED — sign/broadcast/mine all work on Clarity 6.");
  } else {
    console.log(`\n⚠ Not confirmed as success (${status}). Investigate before relying on live broadcasts.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("verify-write failed:", err.message);
  process.exit(1);
});
