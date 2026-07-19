// Inventory pre-split — the managed operation after funding the agent wallet.
//
//   npm run m2:presplit                    # preview: what it would do, broadcast nothing
//   npm run m2:presplit -- --yes-mainnet   # execute
//
// A fresh deposit arrives all in one asset; the agent's own rebalance cap (~10 STX/cycle)
// is a safety rail, not a funding tool — converting a deposit through it would take days.
// This CLI brings FREE inventory to the 50/50 target in chunked swaps, each with a fresh
// quote and slippage guard, confirming between chunks (one signer, no nonce races).
//
// ⚠ OPERATIONAL RULE: engage the agent's kill switch BEFORE running this (two signers on
// one wallet race nonces), and clear it after:
//     bash deploy/watch.sh kill   →  run this  →  bash deploy/watch.sh resume
//
// Never run mid-pilot: funding changes corrupt the measurement window (fund before the
// window opens). The one-time cost is the pool fee on the converted amount (~0.5%).

import { getWallet, getStxBalance, getTokenBalance } from "../m1/wallet.js";
import { activePool, contractId } from "../m1/contracts.js";
import { getPoolState } from "../../src/pool.js";
import { buildSwapYForX, buildSwapXForY } from "../m1/actions.js";
import { withRpc } from "../m1/rpc.js";

const CHUNK_Y = 500_000_000n; // 500 STX per swap — small vs pool reserves (~0.03%)
const SLIP_BPS = 100;
const FEE_USTX = 50_000n;
const MIN_GAP_Y = 25; // don't bother converting less than 25 STX of imbalance

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForTx(txid: string): Promise<boolean> {
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    try {
      const j = await withRpc(async (base) => {
        const r = await fetch(`${base}/extended/v1/tx/${txid}`);
        if (!r.ok) throw new Error(`tx fetch → ${r.status}`);
        return (await r.json()) as { tx_status?: string };
      });
      if (j.tx_status && j.tx_status !== "pending") return j.tx_status === "success";
    } catch { /* transient */ }
  }
  return false;
}

async function main() {
  const live = process.argv.includes("--yes-mainnet");
  const w = await getWallet();
  if (w.network !== "mainnet") throw new Error("mainnet only — set STACKS_NETWORK=mainnet");
  const cfg = activePool();
  const { x, y } = cfg;

  const pool = await getPoolState(contractId(cfg.pool));
  const mid = pool.midXinY;
  const xBase = await getTokenBalance(w.address, w.network, x);
  const stx = await getStxBalance(w.address, w.network);
  const xH = Number(xBase) / 10 ** x.decimals;
  const yH = stx.stx; // y is native STX for the pilot pair
  const xValY = xH * mid;
  const total = xValY + yH;
  const gapY = (yH - xValY) / 2; // >0: too much y → buy x; <0: too much x → sell x

  console.log(`free inventory: ${xH} ${x.symbol} (~${xValY.toFixed(0)} ${y.symbol}) + ${yH.toFixed(2)} ${y.symbol}`);
  console.log(`mid ${mid.toFixed(0)} | imbalance: ${gapY >= 0 ? "buy" : "sell"} ${Math.abs(gapY).toFixed(0)} ${y.symbol} worth of ${x.symbol}\n`);

  if (Math.abs(gapY) < MIN_GAP_Y) { console.log("already balanced — nothing to do"); return; }
  if (!live) { console.log("preview only — add --yes-mainnet to execute"); return; }

  const opts = { senderKey: w.key, network: "mainnet" as const, broadcast: true, slippageBps: SLIP_BPS, feeMicroStx: FEE_USTX };
  let remaining = BigInt(Math.floor(Math.abs(gapY) * 1e6)); // µSTX of value to convert
  let n = 0;
  while (remaining > 0n) {
    const chunkY = remaining > CHUNK_Y ? CHUNK_Y : remaining;
    n++;
    let built;
    if (gapY > 0) {
      built = await buildSwapYForX(chunkY, opts); // spend STX, receive sBTC
    } else {
      const xChunk = BigInt(Math.floor((Number(chunkY) / 1e6 / mid) * 10 ** x.decimals));
      built = await buildSwapXForY(xChunk, opts); // spend sBTC, receive STX
    }
    const txid = built.broadcast?.txid;
    if (!txid) throw new Error(`chunk ${n} broadcast failed: ${built.broadcast?.error}`);
    process.stdout.write(`chunk ${n}: ${Number(chunkY) / 1e6} ${y.symbol} → ${txid.slice(0, 8)}… `);
    const ok = await waitForTx(txid);
    console.log(ok ? "✓" : "✗ FAILED — stopping");
    if (!ok) process.exit(1);
    remaining -= chunkY;
  }
  console.log(`\ndone in ${n} chunks. Re-run to verify: it should report "already balanced".`);
  console.log("Now clear the kill switch: bash deploy/watch.sh resume");
}

main().catch((err) => { console.error("presplit failed:", err.message); process.exit(1); });
