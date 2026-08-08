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
//
// SAFETY: mainnet-only; PREVIEW by default; broadcasts only with --yes-mainnet; Allow mode +
// INPUT-CAP post-conditions on the adds (asset names/decimals RESOLVED from source at runtime);
// withdraw uses nominal min-out guards on the value side (min-sum>0 rule); hard target cap; a
// gas reserve is always kept. NOTE: shares the agent wallet nonce — pause the pilot agent first.
//
//   npm run m1:dlmm-recenter -- status
//   npm run m1:dlmm-recenter -- open 40 --yes-mainnet
//   npm run m1:dlmm-recenter -- recenter --yes-mainnet

import { fetchNonce, fetchCallReadOnlyFunction, cvToJSON } from "@stacks/transactions";
import { getWallet, getStxBalance, type Wallet } from "./wallet.js";
import { DLMM_POOLS, readDlmmState, type DlmmPool } from "./dlmm-read.js";
import { readUserPosition } from "./dlmm-position.js";
import {
  distributeAcrossRange,
  buildAddLiquidity,
  buildWithdrawLiquidity,
  buildInputCaps,
  isNativeStxToken,
  type PoolRefs,
  type BinWithdraw,
} from "./dlmm-write.js";
import { sizeTwoSidedDeposit, decideRecenter } from "./dlmm-recenter.js";
import { executeDescriptor } from "./dlmm-execute.js";

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

interface TokenMeta { principal: string; native: boolean; asset: string; decimals: number }

function parseArgs() {
  const a = process.argv.slice(2);
  const pos = a.filter((x) => !x.startsWith("--"));
  return { action: pos[0], amount: pos[1], yes: a.includes("--yes-mainnet") };
}

async function resolveToken(principal: string): Promise<TokenMeta> {
  if (isNativeStxToken(principal)) return { principal, native: true, asset: "", decimals: 6 };
  const [addr, name] = principal.split(".");
  const iface = await (await fetch(`${API}/v2/contracts/interface/${addr}/${name}`)).json();
  const asset = ((iface.fungible_tokens ?? []).map((f: any) => f.name).find((n: string) => !/locked/.test(n))) ?? name;
  let decimals = 6;
  try {
    const dj = cvToJSON(await fetchCallReadOnlyFunction({ contractAddress: addr, contractName: name, functionName: "get-decimals", functionArgs: [], network: "mainnet", senderAddress: addr })) as any;
    decimals = Number(dj?.value?.value ?? dj?.value ?? 6);
  } catch { /* keep default */ }
  return { principal, native: false, asset, decimals };
}

async function ftBalance(addr: string, assetId: string): Promise<bigint> {
  const j = await (await fetch(`${API}/extended/v1/address/${addr}/balances`)).json();
  const ft = j.fungible_tokens ?? {};
  return ft[assetId] ? BigInt(ft[assetId].balance) : 0n;
}

async function stxPriceUsd(): Promise<number> {
  const j = await (await fetch("https://coins.llama.fi/prices/current/coingecko:blockstack")).json();
  const p = j?.coins?.["coingecko:blockstack"]?.price;
  if (!(p > 0)) throw new Error("could not read STX price");
  return p;
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

// Build + (optionally) broadcast a two-sided open centered on the active bin. Returns txid or null (preview).
async function doOpen(w: Wallet, poolDef: DlmmPool, activeBin: number, xTokenP: string, yTok: TokenMeta, target: number, yes: boolean): Promise<string | null> {
  if (target <= 0 || target > MAX_TARGET_USD) throw new Error(`target must be >0 and ≤ ${MAX_TARGET_USD}`);
  const price = await stxPriceUsd();
  const bal = await getStxBalance(w.address, w.network);
  const usdcxAssetId = `${yTok.principal}::${yTok.asset}`;
  const usdcxBal = await ftBalance(w.address, usdcxAssetId);
  const availStx = bal.microStx > GAS_RESERVE_USTX ? bal.microStx - GAS_RESERVE_USTX : 0n;
  const size = sizeTwoSidedDeposit(target, price, availStx, usdcxBal);
  if (size.xBase <= 0n || size.yBase <= 0n)
    throw new Error(`cannot size two-sided: STX avail ${Number(availStx) / 1e6}, USDCx avail ${Number(usdcxBal) / 1e6}`);

  const deposits = distributeAcrossRange(activeBin, HALF_WIDTH, size.xBase, size.yBase);
  const desc = buildAddLiquidity({ poolName: poolDef.name, xToken: xTokenP, yToken: yTok.principal } as PoolRefs, deposits, { minDlp: MIN_DLP, deadlineTime: Math.floor(Date.now() / 1000) + DEADLINE_SECS });
  const sumX = deposits.reduce((s, d) => s + d.xAmount, 0n);
  const sumY = deposits.reduce((s, d) => s + d.yAmount, 0n);
  const stxCap = sumX + sumX / 50n + 300_000n;
  const usdcxCap = sumY + sumY / 50n;
  const pcs = buildInputCaps(w.address, [
    { token: xTokenP, asset: "", max: stxCap },
    { token: yTok.principal, asset: yTok.asset, max: usdcxCap },
  ]);

  console.log(`  open: ~$${target} → ${(Number(size.xBase) / 1e6).toFixed(3)} STX + ${(Number(size.yBase) / 1e6).toFixed(3)} USDCx across ${deposits.length} bins [${deposits[0].signedBin}..${deposits[deposits.length - 1].signedBin}]`);
  console.log(`  caps: STX ≤ ${(Number(stxCap) / 1e6).toFixed(3)} · USDCx ≤ ${(Number(usdcxCap) / 1e6).toFixed(3)} (${usdcxAssetId})`);
  if (bal.microStx < stxCap + FEE_USTX) throw new Error(`insufficient STX: need ~${Number(stxCap + FEE_USTX) / 1e6}, have ${bal.stx}`);
  if (usdcxBal < usdcxCap) throw new Error(`insufficient USDCx: need ~${Number(usdcxCap) / 1e6}, have ${Number(usdcxBal) / 1e6}`);
  if (!yes) { console.log("  (preview — not broadcast)"); return null; }
  const nonce = await fetchNonce({ address: w.address, network: "mainnet" });
  const r = await executeDescriptor(desc, { live: true, yesMainnet: true, senderKey: w.key, postConditions: pcs, feeMicroStx: FEE_USTX, nonce });
  return r.txid ?? null;
}

async function main() {
  console.log("=== DeepStack — DLMM recenter (two-sided concentrated position) ===\n");
  const { action, amount, yes } = parseArgs();
  if (!["status", "open", "recenter"].includes(action ?? "")) throw new Error("usage: m1:dlmm-recenter -- <status | open <usd> | recenter> [--yes-mainnet]");

  const w = await getWallet();
  if (w.network !== "mainnet") throw new Error(`refusing: STACKS_NETWORK is ${w.network}; DLMM is mainnet-only.`);
  const poolDef = DLMM_POOLS.find((p) => p.key === PAIR);
  if (!poolDef) throw new Error(`unknown DLMM_PAIR '${PAIR}'`);
  const st = await readDlmmState(poolDef);
  if (!st) throw new Error(`could not read pool state for ${PAIR}`);
  const [xTok, yTok] = await Promise.all([resolveToken(st.xToken), resolveToken(st.yToken)]);
  if (!xTok.native) throw new Error("expected X = native STX for the STX-side funding model");
  const pos = await readUserPosition(poolDef, w.address);
  const decision = decideRecenter(st.activeBinId, { lo: pos.lowerSignedBin, hi: pos.upperSignedBin }, HALF_WIDTH);

  console.log(`pair: ${PAIR} | active bin ${st.activeBinId} | step ${st.binStep}bps | x=STX y=${yTok.asset}`);
  console.log(`position: ${pos.bins.length ? `bins [${pos.lowerSignedBin}..${pos.upperSignedBin}], ~${(Number(pos.totalX) / 1e6).toFixed(3)} STX + ${(Number(pos.totalY) / 1e6).toFixed(3)} USDCx` : "none"}`);
  console.log(`decision: ${decision.action} — ${decision.reason}\n`);
  if (action === "status") return;

  if (action === "open") {
    if (pos.bins.length > 0) throw new Error("a position already exists — use `recenter`");
    const txid = await doOpen(w, poolDef, st.activeBinId, st.xToken, yTok, Number(amount ?? TARGET_USD), yes);
    if (txid) { const s = await waitFor(txid); if (s === "success") console.log("\n✅ position opened."); else process.exitCode = 1; }
    else console.log("\n⚠ preview only — re-run with --yes-mainnet (pause the agent first: touch /opt/deepstack/KILL).");
    return;
  }

  // recenter
  if (pos.bins.length === 0) throw new Error("no position — use `open` first");
  if (decision.action === "hold") { console.log("in band — no recenter needed."); return; }

  // 1) withdraw all bins — nominal min-out on the value side (min-sum>0 rule)
  const withdrawals: BinWithdraw[] = pos.bins.map((b) => ({ signedBin: b.signedBin, amount: b.userShares, minX: b.userX > 0n ? 1n : 0n, minY: b.userY > 0n ? 1n : 0n }));
  const wdesc = buildWithdrawLiquidity({ poolName: poolDef.name, xToken: st.xToken, yToken: st.yToken } as PoolRefs, withdrawals, { deadlineTime: Math.floor(Date.now() / 1000) + DEADLINE_SECS });
  console.log(`recenter step 1/2 — withdraw ${pos.bins.length} bins [${pos.lowerSignedBin}..${pos.upperSignedBin}]`);
  if (!yes) { console.log("  (preview — not broadcast)"); }
  else {
    const nonce = await fetchNonce({ address: w.address, network: "mainnet" });
    const r = await executeDescriptor(wdesc, { live: true, yesMainnet: true, senderKey: w.key, allowNoInputCaps: true, feeMicroStx: FEE_USTX, nonce });
    if (!r.txid) throw new Error("withdraw broadcast returned no txid");
    const s = await waitFor(r.txid);
    if (s !== "success") { console.log("\n⚠ withdraw did not confirm — aborting recenter (no re-add)."); process.exitCode = 1; return; }
  }

  // 2) re-add two-sided centered on the CURRENT active bin (re-read — it moves)
  const st2 = (await readDlmmState(poolDef)) ?? st;
  console.log(`recenter step 2/2 — re-add centered on active ${st2.activeBinId}`);
  const txid = await doOpen(w, poolDef, st2.activeBinId, st2.xToken, yTok, TARGET_USD, yes);
  if (txid) { const s = await waitFor(txid); if (s === "success") console.log("\n✅ recenter complete."); else process.exitCode = 1; }
  else console.log("\n⚠ preview only — re-run with --yes-mainnet (pause the agent first).");
}

main().catch((err) => { console.error("dlmm-recenter failed:", err.message); process.exit(1); });
