// Guarded DLMM smoke — the mainnet verification for the concentrated-liquidity write path,
// the analog of m1:smoke for XYK. It proves the DLMM router encoding + Allow-mode input-cap
// post-conditions + broadcast + confirmation work on the real pool, post-fork (Clarity 6).
//
// Design for maximum safety on the FIRST real DLMM write:
//  - SINGLE-SIDED STX only. The only asset that can leave the wallet is native STX, so a single
//    .ustx() input cap bounds the entire risk. No other token is touched, none is needed.
//  - PREVIEW by default; broadcasts only with --yes-mainnet; mainnet-only.
//  - Hard per-run cap on the STX committed.
//  - `add` deploys a tiny single-sided position; `withdraw` recovers it. Run add, confirm on the
//    explorer, then withdraw — a full round trip that leaves the wallet where it started (minus
//    two network fees).
//
//   npm run m1:dlmm-smoke -- add 2                 (preview a 2-STX single-sided add)
//   npm run m1:dlmm-smoke -- add 2 --yes-mainnet
//   npm run m1:dlmm-smoke -- withdraw              (preview the recovery)
//   npm run m1:dlmm-smoke -- withdraw --yes-mainnet
//
// NOTE: uses the agent wallet's nonce — the pilot agent uses the same wallet. Run with the
// agent paused (touch /opt/deepstack/KILL) or when it is not about to broadcast.

import { fetchNonce } from "@stacks/transactions";
import { getWallet, getStxBalance } from "./wallet.js";
import { DLMM_POOLS, readDlmmState } from "./dlmm-read.js";
import { readUserPosition } from "./dlmm-position.js";
import {
  buildAddLiquidity,
  buildWithdrawLiquidity,
  buildInputCaps,
  isNativeStxToken,
  type PoolRefs,
  type BinDeposit,
  type BinWithdraw,
} from "./dlmm-write.js";
import { executeDescriptor } from "./dlmm-execute.js";

const PAIR = process.env.DLMM_PAIR ?? "stx-usdcx"; // STX is a token here; single-sided STX add
const CAP_STX = 5; // hard ceiling on STX committed per run
// Single bin, ONE step off the active bin on the STX side (X above active / Y below). Off-active
// so the deposit is unambiguously single-sided — the active bin itself expects both tokens — and a
// single position means the router's fold can't mask a real error as ERR_NO_RESULT_DATA (u5001).
const SMOKE_STEPS_OFF = 1;
const FEE_USTX = 200_000n; // network fee (0.2 STX)
const PC_HEADROOM_USTX = 100_000n; // 0.1 STX over the deposit to cover the pool's small liquidity fee
const DEADLINE_SECS = 600;
// The core rejects min-dlp = 0 (ERR_INVALID_MIN_DLP_AMOUNT) and floors any deposit's shares at
// minimum-bin-shares (10000 on-chain). 10000 is valid (>0) and always ≤ the shares a 2-STX deposit
// yields, so it never trips ERR_MINIMUM_LP_AMOUNT. (The pilot will compute min-dlp from expected
// shares × (1 − slippage); a tiny single-bin smoke does not need tighter protection.)
const MIN_DLP = 10_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  const a = process.argv.slice(2);
  const yes = a.includes("--yes-mainnet");
  const pos = a.filter((x) => !x.startsWith("--"));
  return { action: pos[0], amount: pos[1], yes };
}

async function main() {
  console.log("=== DeepStack — DLMM smoke (concentrated-liquidity write path) ===\n");
  const { action, amount, yes } = parseArgs();
  if (action !== "add" && action !== "withdraw") {
    throw new Error("usage: m1:dlmm-smoke -- <add <stx> | withdraw> [--yes-mainnet]");
  }

  const w = await getWallet();
  if (w.network !== "mainnet") throw new Error(`refusing: STACKS_NETWORK is ${w.network}; DLMM pools are mainnet-only.`);

  const poolDef = DLMM_POOLS.find((p) => p.key === PAIR);
  if (!poolDef) throw new Error(`unknown DLMM_PAIR '${PAIR}'. Known: ${DLMM_POOLS.map((p) => p.key).join(", ")}`);
  const st = await readDlmmState(poolDef);
  if (!st) throw new Error(`could not read pool state for ${PAIR}`);

  // Which side is native STX? The smoke is STX-single-sided, so one side must be the STX facade.
  const stxIsX = isNativeStxToken(st.xToken);
  const stxIsY = isNativeStxToken(st.yToken);
  if (!stxIsX && !stxIsY) throw new Error(`${PAIR} has no native-STX side; this smoke is STX-only. Pick a STX pool.`);
  const stxToken = stxIsX ? st.xToken : st.yToken;

  const pool: PoolRefs = { poolName: poolDef.name, xToken: st.xToken, yToken: st.yToken };
  const bal = await getStxBalance(w.address, w.network);
  console.log(`pair: ${PAIR} (${poolDef.name})`);
  console.log(`network: mainnet | address: ${w.address}`);
  console.log(`active bin: ${st.activeBinId} | bin step: ${st.binStep}bps | STX side: ${stxIsX ? "x" : "y"}`);
  console.log(`native STX balance: ${bal.stx} STX\n`);

  const deadlineTime = Math.floor(Date.now() / 1000) + DEADLINE_SECS;

  if (action === "add") {
    const amt = Number(amount);
    if (!(amt > 0)) throw new Error(`bad amount: ${amount}`);
    if (amt > CAP_STX) throw new Error(`amount ${amt} exceeds the smoke cap of ${CAP_STX} STX`);
    const totalStx = BigInt(Math.round(amt * 1e6));

    // One bin, one step off the active bin on the STX side (X above / Y below), single-sided.
    const bin = stxIsX ? st.activeBinId + SMOKE_STEPS_OFF : st.activeBinId - SMOKE_STEPS_OFF;
    const deposits: BinDeposit[] = stxIsX
      ? [{ signedBin: bin, xAmount: totalStx, yAmount: 0n }]
      : [{ signedBin: bin, xAmount: 0n, yAmount: totalStx }];

    const desc = buildAddLiquidity(pool, deposits, { minDlp: MIN_DLP, deadlineTime });
    // The wallet sends at most the deposit + a small headroom for the pool's liquidity fee.
    const pcCap = totalStx + PC_HEADROOM_USTX;
    const pcs = buildInputCaps(w.address, [{ token: stxToken, asset: "", max: pcCap }]);

    console.log("action: add-liquidity (single-sided STX)");
    console.log(`  committing: ${amt} STX into bin ${bin} (${SMOKE_STEPS_OFF} step ${stxIsX ? "above" : "below"} active ${st.activeBinId}, single-sided)`);
    console.log(`  input cap: sender sends ≤ ${Number(pcCap) / 1e6} STX (native) — the ONLY asset that can leave`);
    console.log(`  network fee: ${Number(FEE_USTX) / 1e6} STX | deadline: +${DEADLINE_SECS}s`);
    const need = totalStx + PC_HEADROOM_USTX + FEE_USTX;
    if (bal.microStx < need) throw new Error(`insufficient STX: need ~${Number(need) / 1e6}, have ${bal.stx}`);

    if (!yes) return preview();
    console.log("\nbroadcasting…");
    const nonce = await fetchNonce({ address: w.address, network: "mainnet" });
    const r = await executeDescriptor(desc, {
      live: true,
      yesMainnet: true,
      senderKey: w.key,
      postConditions: pcs,
      feeMicroStx: FEE_USTX,
      nonce,
    });
    return await report(r.txid);
  }

  // withdraw — recover the whole position; the wallet only RECEIVES, so no input cap applies.
  const pos = await readUserPosition(poolDef, w.address);
  if (pos.bins.length === 0) {
    console.log("no DLMM position for this wallet in this pool — nothing to withdraw.");
    return;
  }
  // The core requires min-x + min-y > 0 per bin (ERR_INVALID_AMOUNT u1002) — a fully
  // unprotected withdraw is rejected. A single-sided bin holds only one token, so put a
  // minimal 1-unit guard on whichever side currently HAS value and 0 on the empty side.
  // If price flips the bin's composition between this read and the broadcast, the tx aborts
  // cheaply and a re-run re-reads and adapts.
  const withdrawals: BinWithdraw[] = pos.bins.map((b) => ({
    signedBin: b.signedBin,
    amount: b.userShares,
    minX: b.userX > 0n ? 1n : 0n,
    minY: b.userY > 0n ? 1n : 0n,
  }));
  const desc = buildWithdrawLiquidity(pool, withdrawals, { deadlineTime });
  console.log("action: withdraw-liquidity (recover position)");
  console.log(`  bins: ${pos.bins.map((b) => b.signedBin).join(", ")}`);
  console.log(`  est. return: ${Number(pos.totalX) / 1e6} X (STX) + ${Number(pos.totalY) / 1e6} Y (USDCx), approx`);
  console.log(`  min-out guards: minX=${pos.totalX > 0n ? 1 : 0}, minY=${pos.totalY > 0n ? 1 : 0} (nominal — satisfies min-sum>0)`);
  console.log(`  network fee: ${Number(FEE_USTX) / 1e6} STX`);
  if (bal.microStx < FEE_USTX) throw new Error("insufficient STX for the network fee");

  if (!yes) return preview();
  console.log("\nbroadcasting…");
  const nonce = await fetchNonce({ address: w.address, network: "mainnet" });
  const r = await executeDescriptor(desc, {
    live: true,
    yesMainnet: true,
    senderKey: w.key,
    allowNoInputCaps: true, // withdraw only receives — nothing leaves the wallet to cap
    feeMicroStx: FEE_USTX,
    nonce,
  });
  return await report(r.txid);
}

function preview() {
  console.log("\n⚠ PREVIEW ONLY — nothing broadcast.");
  console.log("  Re-run with --yes-mainnet to broadcast this real mainnet transaction.");
  console.log("  Reminder: pause the pilot agent first (touch /opt/deepstack/KILL) — shared nonce.");
}

async function report(txid?: string) {
  if (!txid) {
    console.log("\n✗ broadcast did not return a txid.");
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ BROADCAST. txid: ${txid}`);
  console.log(`  explorer: https://explorer.hiro.so/txid/${txid}?chain=mainnet`);
  console.log("  confirming…");
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    const r = await fetch(`https://api.mainnet.hiro.so/extended/v1/tx/${txid}`);
    if (r.ok) {
      const j = (await r.json()) as { tx_status?: string; tx_result?: { repr?: string } };
      if (j.tx_status && j.tx_status !== "pending") {
        console.log(`  status: ${j.tx_status}${j.tx_result?.repr ? `  result: ${j.tx_result.repr}` : ""}`);
        if (j.tx_status === "success") {
          console.log("\n✅ DLMM write path CONFIRMED on mainnet post-fork.");
        } else {
          console.log("\n⚠ Aborted. The result above is the real (unmasked) error to decode next.");
          process.exitCode = 1;
        }
        return;
      }
    }
    process.stdout.write(".");
  }
  console.log("\n  still pending after 4 min — check the explorer.");
}

main().catch((err) => {
  console.error("dlmm-smoke failed:", err.message);
  process.exit(1);
});
