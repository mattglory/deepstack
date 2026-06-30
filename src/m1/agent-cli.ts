// DeepStack agent loop — read → (AI-tune) → decide → (optionally) act.
//
// Each cycle: (1) if LP is enabled (TARGET_LP_FRACTION>0), move toward the target
// liquidity allocation via add/withdraw — this is what EARNS the pool fee; then
// (2) rebalance free inventory toward the target sBTC/STX split via swaps.
//
// OBSERVE by default. LIVE execution requires --live AND --yes-mainnet,
// mainnet-only, hard caps, balance checks, and per-tx confirmation (no
// double-trading on stale balances), capped at --max-trades per run.
//
//   npm run m1:agent
//   npm run m1:agent -- --interval 60
//   TARGET_LP_FRACTION=0.3 npm run m1:agent -- --live --yes-mainnet

import {
  getWallet,
  getStxBalance,
  getSbtcBalance,
  getLpBalance,
  type Wallet,
} from "./wallet.js";
import { getPoolState } from "../pool.js";
import { getWithdrawQuote } from "./quotes.js";
import {
  buildSwapYForX,
  buildSwapXForY,
  buildAddLiquidity,
  buildWithdrawLiquidity,
  type BuiltTx,
} from "./actions.js";
import {
  decide,
  decideLp,
  defaultParams,
  type Inventory,
  type AgentParams,
} from "./agent.js";
import { tuneParams, type MarketState, type TunedParams } from "./ai/tune.js";
import { getExternalMid, assessSafety, defaultSafetyParams } from "./safety.js";

const POOL_ID = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1";
const CAP_STX_USTX = 25_000_000n;
const CAP_SBTC_BASE = 50_000n;
const FEE_USTX = 50_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lpH = (b: bigint) => Number(b) / 1e6;

function flags() {
  const a = process.argv.slice(2);
  const num = (name: string, def: number) => {
    const i = a.indexOf(name);
    return i !== -1 && Number(a[i + 1]) > 0 ? Number(a[i + 1]) : def;
  };
  return {
    interval: a.includes("--interval") ? num("--interval", 0) : 0,
    live: a.includes("--live"),
    yesMainnet: a.includes("--yes-mainnet"),
    maxTrades: num("--max-trades", 1),
    tuneEvery: num("--tune-every", 10),
  };
}

async function waitForTx(txid: string) {
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const r = await fetch(`https://api.mainnet.hiro.so/extended/v1/tx/${txid}`);
    if (r.ok) {
      const j = (await r.json()) as { tx_status?: string; tx_result?: { repr?: string } };
      if (j.tx_status && j.tx_status !== "pending") return j;
    }
  }
  return { tx_status: "timeout" } as { tx_status: string; tx_result?: { repr?: string } };
}

interface Snapshot {
  midXinY: number;
  inv: Inventory; // free wallet inventory
  stxHuman: number;
  sbtcHuman: number;
  lpBalanceBase: bigint;
  lpValueStx: number;
  portfolioStx: number;
  externalMid: number | null;
  poolActive: boolean;
  market: MarketState;
}

async function readMarket(w: Wallet): Promise<Snapshot> {
  const [pool, stx, sbtc, lp, ext] = await Promise.all([
    getPoolState(POOL_ID),
    getStxBalance(w.address, w.network),
    getSbtcBalance(w.address, w.network),
    getLpBalance(w.address, w.network),
    getExternalMid(),
  ]);
  let lpValueStx = 0;
  if (lp > 0n) {
    const q = await getWithdrawQuote(lp);
    lpValueStx = (Number(q.xOut) / 1e8) * pool.midXinY + Number(q.yOut) / 1e6;
  }
  const freeValue = (Number(sbtc) / 1e8) * pool.midXinY + stx.stx;
  const portfolioStx = freeValue + lpValueStx;
  const stxFraction = freeValue > 0 ? stx.stx / freeValue : 0;
  return {
    midXinY: pool.midXinY,
    inv: { sbtcBase: sbtc, stxMicro: stx.microStx },
    stxHuman: stx.stx,
    sbtcHuman: Number(sbtc) / 1e8,
    lpBalanceBase: lp,
    lpValueStx,
    portfolioStx,
    externalMid: ext?.midXinY ?? null,
    poolActive: pool.poolActive,
    market: { midXinY: pool.midXinY, stxFraction, drift: stxFraction - 0.5, totalStx: freeValue },
  };
}

function refuse(why: string): boolean {
  console.log(`  ✗ refusing live trade: ${why}`);
  return false;
}

async function broadcastResult(built: BuiltTx): Promise<boolean> {
  if (!built.broadcast?.txid) {
    console.log(`  ✗ broadcast failed/aborted: ${built.broadcast?.error}`);
    return false;
  }
  console.log(`  ✓ txid: ${built.broadcast.txid} — confirming…`);
  const res = await waitForTx(built.broadcast.txid);
  console.log(`  status: ${res.tx_status}${res.tx_result?.repr ? ` ${res.tx_result.repr}` : ""}`);
  return res.tx_status === "success";
}

// Returns true if a live trade executed.
async function act(
  w: Wallet,
  s: Snapshot,
  params: AgentParams,
  canTrade: boolean,
  sessionStartStx: number,
): Promise<boolean> {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[${ts}] mid 1 sBTC = ${s.midXinY.toLocaleString()} STX`);
  console.log(
    `  free: ${s.sbtcHuman.toFixed(8)} sBTC + ${s.stxHuman} STX | ` +
      `LP: ${lpH(s.lpBalanceBase).toFixed(6)} (~${s.lpValueStx.toFixed(1)} STX) | ` +
      `portfolio ~${s.portfolioStx.toFixed(1)} STX`,
  );

  // Oracle-sanity + kill-switch gate — never trade on a manipulated/paused venue.
  const safety = assessSafety(
    {
      poolMid: s.midXinY,
      externalMid: s.externalMid,
      poolActive: s.poolActive,
      portfolioStx: s.portfolioStx,
      sessionStartStx,
    },
    defaultSafetyParams(),
  );
  const div = safety.divergenceBps != null ? `${(safety.divergenceBps / 100).toFixed(2)}%` : "n/a";
  console.log(
    `  safety: external ${s.externalMid ? s.externalMid.toLocaleString() : "n/a"} STX/sBTC | divergence ${div} | pool ${s.poolActive ? "active" : "PAUSED"}`,
  );
  if (!safety.safe) {
    console.log(`  ⛔ SAFETY HALT — ${safety.reasons.join("; ")} (no trading this cycle)`);
    return false;
  }

  const opts = {
    senderKey: w.key,
    network: "mainnet" as const,
    broadcast: true,
    slippageBps: params.slippageBps,
    feeMicroStx: FEE_USTX,
  };

  // 1) Liquidity allocation (earns the pool fee) — only if enabled.
  if (params.targetLpFraction > 0) {
    const lp = decideLp(
      s.portfolioStx, s.lpBalanceBase, s.lpValueStx,
      s.inv.sbtcBase, s.inv.stxMicro, s.midXinY, params,
    );
    if (lp.action !== "none") {
      const detail =
        lp.action === "add-liquidity"
          ? `${Number(lp.sbtcBase) / 1e8} sBTC (+ paired STX)`
          : `${lpH(lp.lpBase)} LP`;
      console.log(`  LP: ${lp.action}  ${detail}  (${lp.reason})`);
      if (!canTrade) { console.log("  observe mode — not executing"); return false; }
      if (w.network !== "mainnet") return refuse("not mainnet");
      console.log("  → broadcasting…");
      const built =
        lp.action === "add-liquidity"
          ? await buildAddLiquidity(lp.sbtcBase, opts)
          : await buildWithdrawLiquidity(lp.lpBase, opts);
      return broadcastResult(built);
    }
    console.log(`  LP: hold — ${lp.reason}`);
  }

  // 2) Rebalance free inventory via swap.
  const d = decide(s.inv, s.midXinY, params);
  if (d.action === "none") {
    console.log(`  rebalance: HOLD — ${d.reason}`);
    return false;
  }
  const amt =
    d.action === "swap-y-for-x"
      ? `${Number(d.amountBase) / 1e6} STX → sBTC`
      : `${Number(d.amountBase) / 1e8} sBTC → STX`;
  console.log(`  rebalance: ${d.action}  ${amt}  (${d.reason})`);
  if (!canTrade) { console.log("  observe mode — not executing"); return false; }
  if (w.network !== "mainnet") return refuse("not mainnet");
  if (d.action === "swap-y-for-x" && d.amountBase > CAP_STX_USTX) return refuse("STX over cap");
  if (d.action === "swap-x-for-y" && d.amountBase > CAP_SBTC_BASE) return refuse("sBTC over cap");
  if (d.action === "swap-y-for-x" && s.inv.stxMicro < d.amountBase + FEE_USTX)
    return refuse("insufficient STX for amount + fee");
  console.log("  → broadcasting…");
  const built =
    d.action === "swap-y-for-x"
      ? await buildSwapYForX(d.amountBase, opts)
      : await buildSwapXForY(d.amountBase, opts);
  return broadcastResult(built);
}

function printTune(p: TunedParams) {
  console.log(
    `  [AI] regime=${p.regime} → band=${p.rebalanceBandBps}bps, target=${p.targetStxFraction}, slip=${p.slippageBps}bps` +
      (p.rationale ? `\n       ${p.rationale}` : ""),
  );
}

async function main() {
  const f = flags();
  const live = f.live && f.yesMainnet;
  console.log(
    `=== DeepStack agent — ${live ? "LIVE (executes real txs)" : "OBSERVE (no broadcasting)"} ===`,
  );
  const w = await getWallet();
  console.log(`network: ${w.network} | address: ${w.address}`);
  if (f.live && !f.yesMainnet)
    console.log("note: --live needs --yes-mainnet; running observe-only.");

  let params: AgentParams = defaultParams();
  if (params.targetLpFraction > 0)
    console.log(`LP enabled: target ${(params.targetLpFraction * 100).toFixed(0)}% of portfolio`);

  let trades = 0;
  let i = 0;
  let sessionStartStx = 0;
  const step = async () => {
    const snap = await readMarket(w);
    if (sessionStartStx === 0) sessionStartStx = snap.portfolioStx; // drawdown baseline
    if (i % f.tuneEvery === 0) {
      const tuned = await tuneParams(snap.market, defaultParams());
      params = tuned;
      printTune(tuned);
    }
    i++;
    if (await act(w, snap, params, live && trades < f.maxTrades, sessionStartStx)) trades++;
  };

  await step();
  if (f.interval) {
    console.log(`\n(looping every ${f.interval}s — Ctrl+C to stop)`);
    while (true) {
      await sleep(f.interval * 1000);
      if (live && trades >= f.maxTrades) console.log(`\n(reached --max-trades ${f.maxTrades}; observe-only now)`);
      await step().catch((e) => console.error("cycle error:", e.message));
    }
  }
}

main().catch((err) => {
  console.error("agent failed:", err.message);
  process.exit(1);
});
