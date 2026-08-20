// Guarded DLMM recenter executor — the two-sided concentrated position for the pilot.
//
// v1 is balance-funded, not swap-rebalanced (the DLMM swap has no min-out). It maintains a
// two-sided position sized ~50/50 by value from wallet balances, centered on the active bin:
// X (STX) at/above active, Y (USDCx) at/below (dlmm-write.distributeAcrossRange).
//
// Actions:
//   status      read-only: active bin, resolved tokens, current position, decideRecenter output
//   open <usd>  open a two-sided position (must be flat)
//   recenter    if the active bin has drifted out of the band: withdraw all bins, then re-add
//               two-sided centered on the new active bin (two sequential broadcasts)
//   withdraw    withdraw all bins and stop — no re-add (winding a position down)
//
// SAFETY: mainnet-only; PREVIEW by default; broadcasts only with --yes-mainnet; Allow mode +
// INPUT-CAP post-conditions on the adds (asset names/decimals RESOLVED from source at runtime);
// withdraw uses nominal min-out guards on the value side (min-sum>0 rule); hard target cap; a
// gas reserve is always kept. NOTE: shares the agent wallet nonce — pause the pilot agent first.
//
//   npm run m1:dlmm-recenter -- status
//   npm run m1:dlmm-recenter -- open 40 --yes-mainnet
//   npm run m1:dlmm-recenter -- recenter --yes-mainnet
//   npm run m1:dlmm-recenter -- withdraw --yes-mainnet

import { fetchNonce } from "@stacks/transactions";
import { withRpc } from "./rpc.js";
import { getWallet, getStxBalance, type Wallet } from "./wallet.js";
import { DLMM_POOLS, readDlmmState, type DlmmPool } from "./dlmm-read.js";
import { readUserPosition } from "./dlmm-position.js";
import {
  distributeAcrossRange,
  buildAddLiquidity,
  buildWithdrawLiquidity,
  buildInputCaps,
  type PoolRefs,
  type BinWithdraw,
} from "./dlmm-write.js";
import { sizeTwoSidedDeposit, decideRecenter } from "./dlmm-recenter.js";
import { executeDescriptor } from "./dlmm-execute.js";
// Shared source of truth for token resolution + pricing (handles STX facade vs sBTC etc.).
import { resolveToken, ftBalance, priceOfToken, type TokenMeta } from "./dlmm-recenter-exec.js";

const PAIR = process.env.DLMM_PAIR ?? "stx-usdcx";
const GAS_RESERVE_USTX = 100_000_000n; // keep 100 STX for gas
const HALF_WIDTH = Math.max(1, Math.min(50, Number(process.env.DLMM_HALF_WIDTH ?? 3)));
const TARGET_USD = Number(process.env.DLMM_TARGET_USD ?? 40); // recenter re-adds to this size
const MAX_TARGET_USD = 250;
const MIN_DLP = 10_000n; // pool share floor — valid (>0); input caps are the real bound
const FEE_USTX = 300_000n;
const DEADLINE_SECS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const API = "https://api.mainnet.hiro.so";

function parseArgs() {
  const a = process.argv.slice(2);
  const pos = a.filter((x) => !x.startsWith("--"));
  return { action: pos[0], amount: pos[1], yes: a.includes("--yes-mainnet") };
}

async function waitFor(txid: string): Promise<string> {
  console.log(`  ${txid} — confirming…`);
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    const res = await fetch(`${API}/extended/v1/tx/${txid}`);
    if (res.ok) {
      const j = (await res.json()) as { tx_status?: string; tx_result?: { repr?: string } };
      if (j.tx_status && j.tx_status !== "pending") {
        console.log(`  status: ${j.tx_status}${j.tx_result?.repr ? `  result: ${j.tx_result.repr}` : ""}`);
        return j.tx_status;
      }
    }
    process.stdout.write(".");
  }
  return "timeout";
}

// Build + (optionally) broadcast a two-sided open centered on the active bin. Handles X = native
// STX (stx-usdcx) or a SIP-010 like sBTC (sbtc-usdcx). Returns txid or null (preview).
async function doOpen(w: Wallet, poolDef: DlmmPool, activeBin: number, xTok: TokenMeta, yTok: TokenMeta, target: number, yes: boolean): Promise<string | null> {
  if (target <= 0 || target > MAX_TARGET_USD) throw new Error(`target must be >0 and ≤ ${MAX_TARGET_USD}`);
  const xUnit = 10 ** xTok.decimals, yUnit = 10 ** yTok.decimals;
  const xSym = xTok.asset || "STX";
  const xdp = xTok.decimals === 8 ? 6 : 3;
  const xPrice = await priceOfToken(xTok);
  const nativeStx = (await getStxBalance(w.address, w.network)).microStx;
  if (nativeStx < FEE_USTX) throw new Error(`insufficient native STX for gas (need ~${Number(FEE_USTX) / 1e6})`);
  const xBalRaw = xTok.native ? nativeStx : await ftBalance(w.address, `${xTok.principal}::${xTok.asset}`);
  const availX = xTok.native ? (xBalRaw > GAS_RESERVE_USTX ? xBalRaw - GAS_RESERVE_USTX : 0n) : xBalRaw;
  const availY = await ftBalance(w.address, `${yTok.principal}::${yTok.asset}`);
  const size = sizeTwoSidedDeposit(target, xPrice, availX, availY, xTok.decimals, yTok.decimals);
  if (size.xBase <= 0n || size.yBase <= 0n)
    throw new Error(`cannot size two-sided: ${xSym} avail ${Number(availX) / xUnit}, ${yTok.asset} avail ${Number(availY) / yUnit}`);

  const deposits = distributeAcrossRange(activeBin, HALF_WIDTH, size.xBase, size.yBase);
  const desc = buildAddLiquidity({ poolName: poolDef.name, xToken: xTok.principal, yToken: yTok.principal } as PoolRefs, deposits, { minDlp: MIN_DLP, deadlineTime: Math.floor(Date.now() / 1000) + DEADLINE_SECS });
  const sumX = deposits.reduce((s, d) => s + d.xAmount, 0n);
  const sumY = deposits.reduce((s, d) => s + d.yAmount, 0n);
  const xCap = sumX + sumX / 50n + (xTok.native ? 300_000n : 0n);
  const yCap = sumY + sumY / 50n;
  const pcs = buildInputCaps(w.address, [
    { token: xTok.principal, asset: xTok.asset, max: xCap },
    { token: yTok.principal, asset: yTok.asset, max: yCap },
  ]);

  console.log(`  open: ~$${target} → ${(Number(sumX) / xUnit).toFixed(xdp)} ${xSym} + ${(Number(sumY) / yUnit).toFixed(3)} ${yTok.asset} across ${deposits.length} bins [${deposits[0].signedBin}..${deposits[deposits.length - 1].signedBin}]`);
  console.log(`  caps: ${(Number(xCap) / xUnit).toFixed(xdp)} ${xSym} · ${(Number(yCap) / yUnit).toFixed(3)} ${yTok.asset}`);
  if (xTok.native && nativeStx < xCap + FEE_USTX) throw new Error(`insufficient STX: need ~${Number(xCap + FEE_USTX) / 1e6}, have ${Number(nativeStx) / 1e6}`);
  if (!xTok.native && xBalRaw < xCap) throw new Error(`insufficient ${xSym}: need ~${Number(xCap) / xUnit}, have ${Number(xBalRaw) / xUnit}`);
  if (availY < yCap) throw new Error(`insufficient ${yTok.asset}: need ~${Number(yCap) / yUnit}, have ${Number(availY) / yUnit}`);
  if (!yes) { console.log("  (preview — not broadcast)"); return null; }
  const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl } }));
  const r = await executeDescriptor(desc, { live: true, yesMainnet: true, senderKey: w.key, postConditions: pcs, feeMicroStx: FEE_USTX, nonce });
  return r.txid ?? null;
}

// Withdraw every bin in the current position. Returns true once the withdraw has confirmed
// (or immediately in preview mode, where nothing is broadcast).
async function doWithdraw(w: Wallet, poolDef: DlmmPool, st: Awaited<ReturnType<typeof readDlmmState>>, pos: Awaited<ReturnType<typeof readUserPosition>>, yes: boolean): Promise<boolean> {
  if (!st) throw new Error(`could not read pool state for ${poolDef.key}`);
  const withdrawals: BinWithdraw[] = pos.bins.map((b) => ({ signedBin: b.signedBin, amount: b.userShares, minX: b.userX > 0n ? 1n : 0n, minY: b.userY > 0n ? 1n : 0n }));
  const wdesc = buildWithdrawLiquidity({ poolName: poolDef.name, xToken: st.xToken, yToken: st.yToken } as PoolRefs, withdrawals, { deadlineTime: Math.floor(Date.now() / 1000) + DEADLINE_SECS });
  console.log(`withdraw ${pos.bins.length} bins [${pos.lowerSignedBin}..${pos.upperSignedBin}], ~${(Number(pos.totalX) / 1e6).toFixed(3)} STX + ${(Number(pos.totalY) / 1e6).toFixed(3)} USDCx`);
  if (!yes) { console.log("  (preview — not broadcast)"); return false; }
  const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl } }));
  const r = await executeDescriptor(wdesc, { live: true, yesMainnet: true, senderKey: w.key, allowNoInputCaps: true, feeMicroStx: FEE_USTX, nonce });
  if (!r.txid) throw new Error("withdraw broadcast returned no txid");
  const s = await waitFor(r.txid);
  return s === "success";
}

async function main() {
  console.log("=== DeepStack — DLMM recenter (two-sided concentrated position) ===\n");
  const { action, amount, yes } = parseArgs();
  if (!["status", "open", "recenter", "withdraw"].includes(action ?? "")) throw new Error("usage: m1:dlmm-recenter -- <status | open <usd> | recenter | withdraw> [--yes-mainnet]");

  const w = await getWallet();
  if (w.network !== "mainnet") throw new Error(`refusing: STACKS_NETWORK is ${w.network}; DLMM is mainnet-only.`);
  const poolDef = DLMM_POOLS.find((p) => p.key === PAIR);
  if (!poolDef) throw new Error(`unknown DLMM_PAIR '${PAIR}'`);
  const st = await readDlmmState(poolDef);
  if (!st) throw new Error(`could not read pool state for ${PAIR}`);
  const [xTok, yTok] = await Promise.all([resolveToken(st.xToken), resolveToken(st.yToken)]);
  const pos = await readUserPosition(poolDef, w.address);
  const decision = decideRecenter(st.activeBinId, { lo: pos.lowerSignedBin, hi: pos.upperSignedBin }, HALF_WIDTH);

  console.log(`pair: ${PAIR} | active bin ${st.activeBinId} | step ${st.binStep}bps | x=${xTok.asset || "STX"} y=${yTok.asset}`);
  const xUnit = 10 ** xTok.decimals, yUnit = 10 ** yTok.decimals;
  const xdp = xTok.decimals === 8 ? 6 : 3;
  console.log(`position: ${pos.bins.length ? `bins [${pos.lowerSignedBin}..${pos.upperSignedBin}], ~${(Number(pos.totalX) / xUnit).toFixed(xdp)} ${xTok.asset || "STX"} + ${(Number(pos.totalY) / yUnit).toFixed(3)} ${yTok.asset}` : "none"}`);
  console.log(`decision: ${decision.action} — ${decision.reason}\n`);
  if (action === "status") return;

  if (action === "open") {
    if (pos.bins.length > 0) throw new Error("a position already exists — use `recenter`");
    const txid = await doOpen(w, poolDef, st.activeBinId, xTok, yTok, Number(amount ?? TARGET_USD), yes);
    if (txid) { const s = await waitFor(txid); if (s === "success") console.log("\n✅ position opened."); else process.exitCode = 1; }
    else console.log("\n⚠ preview only — re-run with --yes-mainnet (pause the agent first: touch /opt/deepstack/KILL).");
    return;
  }

  if (action === "withdraw") {
    if (pos.bins.length === 0) throw new Error("no position to withdraw");
    const ok = await doWithdraw(w, poolDef, st, pos, yes);
    if (yes) { if (ok) console.log("\n✅ withdrawn."); else { console.log("\n⚠ withdraw did not confirm."); process.exitCode = 1; } }
    else console.log("\n⚠ preview only — re-run with --yes-mainnet (pause the agent first: touch /opt/deepstack/KILL).");
    return;
  }

  // recenter
  if (pos.bins.length === 0) throw new Error("no position — use `open` first");
  if (decision.action === "hold") { console.log("in band — no recenter needed."); return; }

  // 1) withdraw all bins — nominal min-out on the value side (min-sum>0 rule)
  console.log("recenter step 1/2 —");
  const withdrew = await doWithdraw(w, poolDef, st, pos, yes);
  if (yes && !withdrew) { console.log("\n⚠ withdraw did not confirm — aborting recenter (no re-add)."); process.exitCode = 1; return; }

  // 2) re-add two-sided centered on the CURRENT active bin (re-read — it moves)
  const st2 = (await readDlmmState(poolDef)) ?? st;
  console.log(`recenter step 2/2 — re-add centered on active ${st2.activeBinId}`);
  const txid = await doOpen(w, poolDef, st2.activeBinId, xTok, yTok, TARGET_USD, yes);
  if (txid) { const s = await waitFor(txid); if (s === "success") console.log("\n✅ recenter complete."); else process.exitCode = 1; }
  else console.log("\n⚠ preview only — re-run with --yes-mainnet (pause the agent first).");
}

main().catch((err) => { console.error("dlmm-recenter failed:", err.message); process.exit(1); });
