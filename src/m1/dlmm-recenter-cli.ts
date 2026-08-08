// Guarded DLMM recenter executor — the two-sided concentrated position for the pilot.
//
// v1 is balance-funded, not swap-rebalanced (the DLMM swap has no min-out). It opens a
// two-sided position sized ~50/50 by value from wallet balances, centered on the active bin:
// X (STX) at/above active, Y (USDCx) at/below (dlmm-write.distributeAcrossRange).
//
// SAFETY, same contract as the smoke:
//  - mainnet-only; PREVIEW by default; broadcasts only with --yes-mainnet
//  - Allow mode + INPUT-CAP post-conditions on BOTH tokens; asset names/decimals are RESOLVED
//    from each token contract at runtime (never hardcoded — usdcx's SIP-010 asset is
//    "usdcx-token", not "usdcx"; a wrong name would make the cap a silent no-op)
//  - hard cap on target value; a gas reserve is always kept in native STX
//  - min-dlp = the pool share floor (valid, >0); the input caps are the real spend bound
//
//   npm run m1:dlmm-recenter -- status
//   npm run m1:dlmm-recenter -- open 40                (preview a ~$40 two-sided position)
//   npm run m1:dlmm-recenter -- open 40 --yes-mainnet
//
// NOTE: uses the agent wallet's nonce — pause the pilot agent first (touch /opt/deepstack/KILL).

import { fetchNonce, fetchCallReadOnlyFunction, cvToJSON } from "@stacks/transactions";
import { getWallet, getStxBalance } from "./wallet.js";
import { DLMM_POOLS, readDlmmState } from "./dlmm-read.js";
import { readUserPosition } from "./dlmm-position.js";
import { distributeAcrossRange, buildAddLiquidity, buildInputCaps, isNativeStxToken, type PoolRefs } from "./dlmm-write.js";
import { sizeTwoSidedDeposit, decideRecenter } from "./dlmm-recenter.js";
import { executeDescriptor } from "./dlmm-execute.js";

const PAIR = process.env.DLMM_PAIR ?? "stx-usdcx";
const GAS_RESERVE_USTX = 100_000_000n; // keep 100 STX for gas, never deploy it
const HALF_WIDTH = Number(process.env.DLMM_HALF_WIDTH ?? 3); // small first position; agent uses binRangeFromVol
const MAX_TARGET_USD = 250;
const MIN_DLP = 10_000n; // pool share floor — valid (>0); input caps are the real bound
const FEE_USTX = 300_000n; // multi-bin call
const DEADLINE_SECS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const API = "https://api.mainnet.hiro.so";

function parseArgs() {
  const a = process.argv.slice(2);
  const pos = a.filter((x) => !x.startsWith("--"));
  return { action: pos[0], amount: pos[1], yes: a.includes("--yes-mainnet") };
}

// Resolve a token's real SIP-010 asset name + decimals from its own contract (never hardcode).
async function resolveToken(principal: string): Promise<{ principal: string; native: boolean; asset: string; decimals: number }> {
  if (isNativeStxToken(principal)) return { principal, native: true, asset: "", decimals: 6 };
  const [addr, name] = principal.split(".");
  const iface = await (await fetch(`${API}/v2/contracts/interface/${addr}/${name}`)).json();
  const asset = ((iface.fungible_tokens ?? []).map((f: any) => f.name).find((n: string) => !/locked/.test(n))) ?? name;
  let decimals = 6;
  try {
    const dj = cvToJSON(
      await fetchCallReadOnlyFunction({ contractAddress: addr, contractName: name, functionName: "get-decimals", functionArgs: [], network: "mainnet", senderAddress: addr }),
    ) as any;
    decimals = Number(dj?.value?.value ?? dj?.value ?? 6);
  } catch { /* keep default */ }
  return { principal, native: false, asset, decimals };
}

async function ftBalance(addr: string, assetId: string): Promise<bigint> {
  const j = await (await fetch(`${API}/extended/v1/address/${addr}/balances`)).json();
  const ft = j.fungible_tokens ?? {};
  const key = Object.keys(ft).find((k) => k === assetId);
  return key ? BigInt(ft[key].balance) : 0n;
}

async function stxPriceUsd(): Promise<number> {
  const j = await (await fetch("https://coins.llama.fi/prices/current/coingecko:blockstack")).json();
  const p = j?.coins?.["coingecko:blockstack"]?.price;
  if (!(p > 0)) throw new Error("could not read STX price");
  return p;
}

async function main() {
  console.log("=== DeepStack — DLMM recenter (two-sided concentrated position) ===\n");
  const { action, amount, yes } = parseArgs();
  if (action !== "status" && action !== "open") throw new Error("usage: m1:dlmm-recenter -- <status | open <usd>> [--yes-mainnet]");

  const w = await getWallet();
  if (w.network !== "mainnet") throw new Error(`refusing: STACKS_NETWORK is ${w.network}; DLMM is mainnet-only.`);
  const poolDef = DLMM_POOLS.find((p) => p.key === PAIR);
  if (!poolDef) throw new Error(`unknown DLMM_PAIR '${PAIR}'`);
  const st = await readDlmmState(poolDef);
  if (!st) throw new Error(`could not read pool state for ${PAIR}`);

  const [xTok, yTok] = await Promise.all([resolveToken(st.xToken), resolveToken(st.yToken)]);
  const pos = await readUserPosition(poolDef, w.address);
  const halfWidth = Math.max(1, Math.min(50, HALF_WIDTH));
  const decision = decideRecenter(st.activeBinId, { lo: pos.lowerSignedBin, hi: pos.upperSignedBin }, halfWidth);

  console.log(`pair: ${PAIR} (${poolDef.name}) | active bin ${st.activeBinId} | step ${st.binStep}bps`);
  console.log(`x=${xTok.native ? "STX(native)" : xTok.asset} (${xTok.decimals}dp) | y=${yTok.native ? "STX(native)" : yTok.asset} (${yTok.decimals}dp)`);
  console.log(`position: ${pos.bins.length ? `bins [${pos.lowerSignedBin}..${pos.upperSignedBin}]` : "none"}`);
  console.log(`decision: ${decision.action} — ${decision.reason}\n`);
  if (action === "status") return;

  // open — must be flat (recenter/withdraw is a separate step)
  if (pos.bins.length > 0) throw new Error("a position already exists — `open` is for a flat wallet (recenter comes later)");
  if (!xTok.native) throw new Error("expected X to be native STX for the STX-side single-token funding model");

  const target = Number(amount ?? 40);
  if (!(target > 0) || target > MAX_TARGET_USD) throw new Error(`target must be >0 and ≤ ${MAX_TARGET_USD} USD`);
  const price = await stxPriceUsd();
  const bal = await getStxBalance(w.address, w.network);
  const usdcxAssetId = `${yTok.principal}::${yTok.asset}`;
  const usdcxBal = await ftBalance(w.address, usdcxAssetId);
  const availStx = bal.microStx > GAS_RESERVE_USTX ? bal.microStx - GAS_RESERVE_USTX : 0n;

  const size = sizeTwoSidedDeposit(target, price, availStx, usdcxBal);
  if (size.xBase <= 0n || size.yBase <= 0n)
    throw new Error(`cannot size a two-sided position: STX avail ${Number(availStx) / 1e6}, USDCx avail ${Number(usdcxBal) / 1e6}`);

  const deposits = distributeAcrossRange(st.activeBinId, halfWidth, size.xBase, size.yBase);
  const desc = buildAddLiquidity({ poolName: poolDef.name, xToken: st.xToken, yToken: st.yToken } as PoolRefs, deposits, { minDlp: MIN_DLP, deadlineTime: Math.floor(Date.now() / 1000) + DEADLINE_SECS });

  const sumX = deposits.reduce((s, d) => s + d.xAmount, 0n);
  const sumY = deposits.reduce((s, d) => s + d.yAmount, 0n);
  const stxCap = sumX + (sumX / 50n) + 300_000n; // +2% + 0.3 STX headroom for the pool's liquidity fee
  const usdcxCap = sumY + sumY / 50n; // +2%
  const pcs = buildInputCaps(w.address, [
    { token: st.xToken, asset: "", max: stxCap },
    { token: st.yToken, asset: yTok.asset, max: usdcxCap },
  ]);

  console.log("action: open two-sided position");
  console.log(`  target ~$${target} at STX=$${price.toFixed(4)} → ${(Number(size.xBase) / 1e6).toFixed(4)} STX + ${(Number(size.yBase) / 1e6).toFixed(4)} USDCx (~$${size.valueUsd.toFixed(2)})`);
  console.log(`  spread across ${deposits.length} bins [${deposits[0].signedBin}..${deposits[deposits.length - 1].signedBin}], half-width ${halfWidth}`);
  console.log(`  input caps: STX ≤ ${(Number(stxCap) / 1e6).toFixed(4)} (native) · USDCx ≤ ${(Number(usdcxCap) / 1e6).toFixed(4)} (${usdcxAssetId})`);
  console.log(`  network fee: ${Number(FEE_USTX) / 1e6} STX | min-dlp/bin: ${MIN_DLP}`);
  if (bal.microStx < stxCap + FEE_USTX) throw new Error(`insufficient STX: need ~${Number(stxCap + FEE_USTX) / 1e6}, have ${bal.stx}`);
  if (usdcxBal < usdcxCap) throw new Error(`insufficient USDCx: need ~${Number(usdcxCap) / 1e6}, have ${Number(usdcxBal) / 1e6}`);

  if (!yes) {
    console.log("\n⚠ PREVIEW ONLY — nothing broadcast. Re-run with --yes-mainnet.");
    console.log("  Reminder: pause the pilot agent first (touch /opt/deepstack/KILL) — shared nonce.");
    return;
  }
  console.log("\nbroadcasting…");
  const nonce = await fetchNonce({ address: w.address, network: "mainnet" });
  const r = await executeDescriptor(desc, { live: true, yesMainnet: true, senderKey: w.key, postConditions: pcs, feeMicroStx: FEE_USTX, nonce });
  await report(r.txid);
}

async function report(txid?: string) {
  if (!txid) { console.log("\n✗ no txid returned."); process.exitCode = 1; return; }
  console.log(`\n✓ BROADCAST. txid: ${txid}`);
  console.log(`  explorer: https://explorer.hiro.so/txid/${txid}?chain=mainnet`);
  console.log("  confirming…");
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    const res = await fetch(`${API}/extended/v1/tx/${txid}`);
    if (res.ok) {
      const j = (await res.json()) as { tx_status?: string; tx_result?: { repr?: string } };
      if (j.tx_status && j.tx_status !== "pending") {
        console.log(`  status: ${j.tx_status}${j.tx_result?.repr ? `  result: ${j.tx_result.repr}` : ""}`);
        if (j.tx_status === "success") console.log("\n✅ Two-sided DLMM position opened on mainnet.");
        else { console.log("\n⚠ Aborted. The result above is the real error to decode."); process.exitCode = 1; }
        return;
      }
    }
    process.stdout.write(".");
  }
  console.log("\n  still pending after 4 min — check the explorer.");
}

main().catch((err) => { console.error("dlmm-recenter failed:", err.message); process.exit(1); });
