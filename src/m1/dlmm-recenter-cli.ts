// Guarded DLMM recenter executor — the two-sided concentrated position for the pilot.
//
// v1 is balance-funded, not swap-rebalanced (the DLMM swap has no min-out). It maintains a
// two-sided position sized ~50/50 by value from wallet balances, centered on the active bin:
// X (STX) at/above active, Y (USDCx) at/below (dlmm-write.distributeAcrossRange).
//
// Half-width sizing is shared with the live agent (dlmmSigmaDaily/resolveHalfWidth in
// dlmm-recenter-exec.ts), not a value this file picks on its own — DLMM_HALF_WIDTH (env) is
// only the floor used until there's enough telemetry history to compute a real vol-scaled
// width. Before 2026-10-05 this CLI had its own disconnected flat ±3-bin default, which let a
// manual recenter open a position narrow enough to drift out of range in hours while the
// agent's own (vol-scaled, much wider) trigger judged the drift insignificant and never acted.
//
// Actions:
//   status      read-only: active bin, resolved tokens, current position, decideRecenter output
//   open <usd>  open a two-sided position (must be flat)
//   recenter    if the active bin has drifted out of the band: withdraw all bins, then re-add
//               two-sided centered on the new active bin (two sequential broadcasts)
//   --half-width=N   choose the width deliberately (1-50 bins). Without it, open/recenter with
//                    --yes-mainnet REFUSES when there's no vol history (the old silent ±3
//                    fallback stranded a position on 2026-10-07); run on the server instead.
//   withdraw    withdraw all bins and stop — no re-add (winding a position down)
//   reset-basis no broadcast: reset the dashboard's dlmmBasis to the currently confirmed
//               position and push it to the gist immediately (recovery for the stale-basis
//               bug the `open`/`recenter` fixes above now prevent going forward)
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
import { withRpc, hiroFetch } from "./rpc.js";
import { getWallet, getStxBalance, type Wallet } from "./wallet.js";
import { DLMM_POOLS, readDlmmState, readBinLiquidityStates, readShareFloors, type DlmmPool, type DlmmState } from "./dlmm-read.js";
import { readUserPosition } from "./dlmm-position.js";
import {
  distributeAcrossRange,
  buildAddLiquidity,
  buildWithdrawLiquidity,
  buildInputCaps,
  type PoolRefs,
  type BinWithdraw,
} from "./dlmm-write.js";
import { sizeTwoSidedDeposit, decideRecenter, expectedDlp, minDlpFromExpected } from "./dlmm-recenter.js";
import { executeDescriptor } from "./dlmm-execute.js";
// Shared source of truth for token resolution + pricing (handles STX facade vs sBTC etc.) AND
// for half-width sizing (dlmmSigmaDaily/resolveHalfWidth) — see their doc comments there for
// why this CLI no longer has its own, disconnected fixed-width default.
import { resolveToken, ftBalance, priceOfToken, dlmmSigmaDaily, resolveHalfWidth, type TokenMeta } from "./dlmm-recenter-exec.js";
import { setDlmmBasis } from "./metrics.js";
import { publishMetrics, isPublishConfigured } from "./publish.js";

const PAIR = process.env.DLMM_PAIR ?? "stx-usdcx";
const GAS_RESERVE_USTX = 100_000_000n; // keep 100 STX for gas
// Floor/fallback ONLY — used when there isn't yet enough telemetry history to compute a real
// vol-scaled width (dlmmSigmaDaily() returns null). Once history exists, resolveHalfWidth()
// below overrides this with the SAME vol-scaled width the live agent uses, so a manual
// open/recenter through this CLI can never again size a position the automated agent's own
// drift trigger disagrees with.
const FALLBACK_HALF_WIDTH = Math.max(1, Math.min(50, Number(process.env.DLMM_HALF_WIDTH ?? 3)));
const TARGET_USD = Number(process.env.DLMM_TARGET_USD ?? 40); // recenter re-adds to this size
// Same cap as dlmm-recenter-exec.ts's executeAdd, same reasoning: configurable, not a bare
// 250, so a deliberately-larger pilot position doesn't need another code edit each time.
const MAX_TARGET_USD = Number(process.env.DLMM_MAX_TARGET_USD ?? 250);
const ADD_MIN_DLP_SLIPPAGE_BPS = 100; // matches dlmm-recenter-exec.ts's live-agent value
const FEE_USTX = 300_000n;
const DEADLINE_SECS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function parseArgs() {
  const a = process.argv.slice(2);
  const pos = a.filter((x) => !x.startsWith("--"));
  const hwFlag = a.find((x) => x.startsWith("--half-width="));
  const explicitHalfWidth = hwFlag ? Number(hwFlag.split("=")[1]) : null;
  if (explicitHalfWidth !== null && !(Number.isInteger(explicitHalfWidth) && explicitHalfWidth >= 1 && explicitHalfWidth <= 50)) {
    throw new Error("--half-width must be a whole number of bins from 1 to 50");
  }
  return { action: pos[0], amount: pos[1], yes: a.includes("--yes-mainnet"), explicitHalfWidth };
}

async function waitFor(txid: string): Promise<string> {
  console.log(`  ${txid} — confirming…`);
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    try {
      const j = await withRpc((baseUrl) =>
        hiroFetch(baseUrl)(`${baseUrl}/extended/v1/tx/${txid}`).then((res) => {
          if (!res.ok) throw new Error(`tx status fetch failed: ${res.status}`);
          return res.json() as Promise<{ tx_status?: string; tx_result?: { repr?: string } }>;
        }),
      );
      if (j.tx_status && j.tx_status !== "pending") {
        console.log(`  status: ${j.tx_status}${j.tx_result?.repr ? `  result: ${j.tx_result.repr}` : ""}`);
        return j.tx_status;
      }
    } catch {
      // no endpoint answered (or all timed out) this poll — treat as still-pending, retry
    }
    process.stdout.write(".");
  }
  return "timeout";
}

// Build + (optionally) broadcast a two-sided open centered on the active bin. Handles X = native
// STX (stx-usdcx) or a SIP-010 like sBTC (sbtc-usdcx). Returns txid or null (preview).
async function doOpen(w: Wallet, poolDef: DlmmPool, st: DlmmState, xTok: TokenMeta, yTok: TokenMeta, target: number, yes: boolean, halfWidth: number): Promise<string | null> {
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

  const deposits = distributeAcrossRange(st.activeBinId, halfWidth, size.xBase, size.yBase);
  // Same per-bin min-dlp sizing as the live agent (dlmm-recenter-exec.ts) — this CLI used to
  // have its OWN flat MIN_DLP=10000, a second copy of the bug that caused the 2026-09-21
  // incident. An attended run through this CLI is meant to validate the same logic the
  // autonomous agent runs; it can't do that while sizing min-dlp differently.
  const bins = await readBinLiquidityStates(poolDef, st.coreAddress, st.initialPrice, st.binStep, deposits.map((d) => d.signedBin));
  const { minBinShares, minBurntShares } = await readShareFloors(st.coreAddress);
  const sized = deposits.map((d) => {
    const bin = bins.get(d.signedBin);
    if (!bin) throw new Error(`no live state for bin ${d.signedBin} — aborting rather than guessing min-dlp`);
    const expected = expectedDlp(d.xAmount, d.yAmount, bin, minBurntShares);
    const floor = bin.binShares === 0n ? minBinShares : 1n;
    return { ...d, minDlp: minDlpFromExpected(expected, ADD_MIN_DLP_SLIPPAGE_BPS, floor) };
  });
  console.log(`  min-dlp per bin: ${sized.map((d) => `${d.signedBin}:${d.minDlp}`).join(", ")}`);
  const desc = buildAddLiquidity({ poolName: poolDef.name, xToken: xTok.principal, yToken: yTok.principal } as PoolRefs, sized, { deadlineTime: Math.floor(Date.now() / 1000) + DEADLINE_SECS });
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
  const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
  const r = await executeDescriptor(desc, { live: true, yesMainnet: true, senderKey: w.key, postConditions: pcs, feeMicroStx: FEE_USTX, nonce });
  return r.txid ?? null;
}

// Withdraw every bin in the current position. Returns true once the withdraw has confirmed
// (or immediately in preview mode, where nothing is broadcast).
async function doWithdraw(w: Wallet, poolDef: DlmmPool, st: Awaited<ReturnType<typeof readDlmmState>>, pos: Awaited<ReturnType<typeof readUserPosition>>, yes: boolean): Promise<boolean> {
  if (!st) throw new Error(`could not read pool state for ${poolDef.key}`);
  const withdrawals: BinWithdraw[] = pos.bins.map((b) => ({ signedBin: b.signedBin, amount: b.userShares, minX: b.userX > 0n ? 1n : 0n, minY: b.userY > 0n ? 1n : 0n }));
  const wdesc = buildWithdrawLiquidity({ poolName: poolDef.name, xToken: st.xToken, yToken: st.yToken } as PoolRefs, withdrawals, { deadlineTime: Math.floor(Date.now() / 1000) + DEADLINE_SECS });
  // Real decimals and asset names, not a hardcoded /1e6 + "STX" label — wrong on both counts
  // for any pool where X isn't native STX (e.g. sbtc-usdcx, 8 decimals): a human reviewing
  // this preview before confirming a broadcast deserves the real amount and the real asset.
  // Same bug, same fix as dlmm-recenter-exec.ts's RecenterResult.posX (found 2026-09-30).
  const [xTok, yTok] = await Promise.all([resolveToken(st.xToken), resolveToken(st.yToken)]);
  const xUnit = 10 ** xTok.decimals, yUnit = 10 ** yTok.decimals;
  const xdp = xTok.decimals === 8 ? 6 : 3;
  console.log(`withdraw ${pos.bins.length} bins [${pos.lowerSignedBin}..${pos.upperSignedBin}], ~${(Number(pos.totalX) / xUnit).toFixed(xdp)} ${xTok.asset || "STX"} + ${(Number(pos.totalY) / yUnit).toFixed(3)} ${yTok.asset}`);
  if (!yes) { console.log("  (preview — not broadcast)"); return false; }
  const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
  const r = await executeDescriptor(wdesc, { live: true, yesMainnet: true, senderKey: w.key, allowNoInputCaps: true, feeMicroStx: FEE_USTX, nonce });
  if (!r.txid) throw new Error("withdraw broadcast returned no txid");
  const s = await waitFor(r.txid);
  return s === "success";
}

async function main() {
  console.log("=== DeepStack — DLMM recenter (two-sided concentrated position) ===\n");
  const { action, amount, yes, explicitHalfWidth } = parseArgs();
  if (!["status", "open", "recenter", "withdraw", "reset-basis"].includes(action ?? "")) throw new Error("usage: m1:dlmm-recenter -- <status | open <usd> | recenter | withdraw | reset-basis> [--yes-mainnet]");

  const w = await getWallet();
  if (w.network !== "mainnet") throw new Error(`refusing: STACKS_NETWORK is ${w.network}; DLMM is mainnet-only.`);
  const poolDef = DLMM_POOLS.find((p) => p.key === PAIR);
  if (!poolDef) throw new Error(`unknown DLMM_PAIR '${PAIR}'`);
  const st = await readDlmmState(poolDef);
  if (!st) throw new Error(`could not read pool state for ${PAIR}`);
  const [xTok, yTok] = await Promise.all([resolveToken(st.xToken), resolveToken(st.yToken)]);
  const pos = await readUserPosition(poolDef, w.address);
  // Same vol-scaled width the live agent uses (resolveHalfWidth, shared in dlmm-recenter-exec.ts)
  // — falls back to FALLBACK_HALF_WIDTH only when there isn't yet enough telemetry history.
  const sigmaDaily = dlmmSigmaDaily();
  // An explicit --half-width=N is a deliberate human choice and wins. Otherwise use the live
  // agent's vol-scaled width. The silent ±3 fallback is no longer allowed to OPEN anything:
  // on 2026-10-07 a manual recenter run from a laptop (no vol history there) opened a 7-bin
  // position that went out of range within hours. Broadcasting open/recenter without vol data
  // or an explicit width now refuses below; previews and status still work.
  const halfWidth = explicitHalfWidth ?? resolveHalfWidth(sigmaDaily, st.binStep, FALLBACK_HALF_WIDTH);
  const widthIsFallback = explicitHalfWidth === null && !(sigmaDaily != null && sigmaDaily > 0);
  const decision = decideRecenter(st.activeBinId, { lo: pos.lowerSignedBin, hi: pos.upperSignedBin }, halfWidth);

  console.log(`pair: ${PAIR} | active bin ${st.activeBinId} | step ${st.binStep}bps | half-width ${halfWidth}${sigmaDaily ? ` (vol ${(sigmaDaily * 100).toFixed(2)}%/day)` : " (fallback — no vol history yet)"}${explicitHalfWidth !== null ? " [set by --half-width]" : ""} | x=${xTok.asset || "STX"} y=${yTok.asset}`);
  const xUnit = 10 ** xTok.decimals, yUnit = 10 ** yTok.decimals;
  const xdp = xTok.decimals === 8 ? 6 : 3;
  console.log(`position: ${pos.bins.length ? `bins [${pos.lowerSignedBin}..${pos.upperSignedBin}], ~${(Number(pos.totalX) / xUnit).toFixed(xdp)} ${xTok.asset || "STX"} + ${(Number(pos.totalY) / yUnit).toFixed(3)} ${yTok.asset}` : "none"}`);
  console.log(`decision: ${decision.action} — ${decision.reason}\n`);
  if (action === "status") return;

  if (action === "reset-basis") {
    // No broadcast -- pure recovery for the stale-basis bug (see the `recenter` branch's
    // comment). Resets dlmmBasis to the CURRENTLY confirmed position and pushes straight to
    // the gist, rather than waiting up to one agent cycle for the dashboard to catch up.
    if (pos.bins.length === 0) throw new Error("no open DLMM position to reset the basis to");
    setDlmmBasis({ xQty: Number(pos.totalX) / xUnit, yQty: Number(pos.totalY) / yUnit, t: new Date().toISOString() });
    console.log("cost basis reset to the confirmed deposited legs.");
    if (isPublishConfigured()) {
      const ok = await publishMetrics();
      console.log(ok ? "published to the gist mirror." : "gist publish failed — dashboard will pick this up on the agent's next cycle instead.");
    } else {
      console.log("gist publish not configured here — dashboard will pick this up on the agent's next cycle.");
    }
    return;
  }

  // Refuse to broadcast a position at the silent fallback width (see the halfWidth comment).
  const refuseFallbackWidth = () => {
    if (yes && widthIsFallback) {
      throw new Error(
        `no volatility history here, so the width would fall back to ±${halfWidth} bins, which strands positions out of range (2026-10-07). ` +
          "Run this on the server, where the agent's history lives, or choose a width deliberately with --half-width=N.",
      );
    }
  };

  if (action === "open") {
    refuseFallbackWidth();
    if (pos.bins.length > 0) throw new Error("a position already exists — use `recenter`");
    const txid = await doOpen(w, poolDef, st, xTok, yTok, Number(amount ?? TARGET_USD), yes, halfWidth);
    if (txid) {
      const s = await waitFor(txid);
      if (s === "success") {
        console.log("\n✅ position opened.");
        // Explicit basis reset — see metrics.ts's setDlmmBasis doc comment. A manual
        // withdraw-then-reopen (exactly what this command does for a deliberate resize)
        // can run faster than one agent cycle, so the passive reset-on-reopen in
        // recordSample() never observes the empty state and the old basis silently
        // persists against the new position (found 2026-09-30: a $150 basis valuing a
        // freshly-opened $600 position, producing a fabricated +14,330% APR).
        try {
          const confirmedPos = await readUserPosition(poolDef, w.address);
          setDlmmBasis({
            xQty: Number(confirmedPos.totalX) / xUnit,
            yQty: Number(confirmedPos.totalY) / yUnit,
            t: new Date().toISOString(),
          });
          console.log("   cost basis reset to the confirmed deposited legs.");
        } catch (err) {
          console.log(`   (basis reset skipped: ${(err as Error).message})`);
        }
      } else process.exitCode = 1;
    }
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
  refuseFallbackWidth();

  // 1) withdraw all bins — nominal min-out on the value side (min-sum>0 rule)
  console.log("recenter step 1/2 —");
  const withdrew = await doWithdraw(w, poolDef, st, pos, yes);
  if (yes && !withdrew) { console.log("\n⚠ withdraw did not confirm — aborting recenter (no re-add)."); process.exitCode = 1; return; }

  // 2) re-add two-sided centered on the CURRENT active bin (re-read — it moves)
  const st2 = (await readDlmmState(poolDef)) ?? st;
  console.log(`recenter step 2/2 — re-add centered on active ${st2.activeBinId}`);
  const txid = await doOpen(w, poolDef, st2, xTok, yTok, TARGET_USD, yes, halfWidth);
  if (txid) {
    const s = await waitFor(txid);
    if (s === "success") {
      console.log("\n✅ recenter complete.");
      // Same explicit basis reset `open` already does, and for the same reason (see its
      // comment above) -- `recenter` withdraws then re-adds too, and missing this here
      // produced exactly the stale-basis bug on 2026-10-05: a manual recenter via this
      // command left dlmmBasis pointing at the OLD (much larger) position, so the
      // dashboard compared the new, small position's value against it and reported a
      // fabricated ~-1,487 STX DLMM P&L / -6,313% APR.
      try {
        const confirmedPos = await readUserPosition(poolDef, w.address);
        setDlmmBasis({
          xQty: Number(confirmedPos.totalX) / xUnit,
          yQty: Number(confirmedPos.totalY) / yUnit,
          t: new Date().toISOString(),
        });
        console.log("   cost basis reset to the confirmed deposited legs.");
      } catch (err) {
        console.log(`   (basis reset skipped: ${(err as Error).message})`);
      }
    } else process.exitCode = 1;
  } else console.log("\n⚠ preview only — re-run with --yes-mainnet (pause the agent first).");
}

main().catch((err) => { console.error("dlmm-recenter failed:", err.message); process.exit(1); });
