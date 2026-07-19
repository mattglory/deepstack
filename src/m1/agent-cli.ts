// DeepStack agent loop — read → (AI-tune) → decide → (optionally) act.
// Pair-agnostic: operates on whichever pair PAIR selects (default sbtc-stx).
//
// Each cycle: safety gate → (if LP enabled) move toward target LP allocation →
// else rebalance free inventory toward the target x/y value split via swaps.
// OBSERVE by default; LIVE requires --live AND --yes-mainnet, mainnet-only, caps,
// fee headroom, and per-tx confirmation, capped at --max-trades per run.
//
//   npm run m1:agent
//   PAIR=stx-aeusdc npm run m1:agent -- --interval 60
//   TARGET_LP_FRACTION=0.3 npm run m1:agent -- --live --yes-mainnet

import { getWallet, getStxBalance, getTokenBalance, getLpBalance, type Wallet } from "./wallet.js";
import { getPoolState } from "../pool.js";
import { getWithdrawQuote } from "./quotes.js";
import { activePool, contractId } from "./contracts.js";
import {
  buildSwapYForX,
  buildSwapXForY,
  buildAddLiquidity,
  buildWithdrawLiquidity,
  type BuiltTx,
} from "./actions.js";
import { decide, decideLp, defaultParams, bandBpsFromVol, exceedsPoolShare, type Inventory, type AgentParams } from "./agent.js";
import { tuneParams, type MarketState, type TunedParams } from "./ai/tune.js";
import { getExternalMid, assessSafety, defaultSafetyParams } from "./safety.js";
import { recordSample, loadHistory, adjustLpBasis } from "./metrics.js";
import { realizedVolDaily } from "./lvr.js";
import { appendJournal, pingHealthcheck } from "./journal.js";
import { publishMetrics } from "./publish.js";
import { withRpc } from "./rpc.js";
import { findArb } from "./arb.js";
import { createSupervisor } from "./supervise.js";

// Per-tick journal record (audit trail); assembled across act()/refuse()/broadcastResult()
// and flushed once per tick in step(). See src/m1/journal.ts.
let tickJournal: Record<string, unknown> = {};

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
    try {
      const j = await withRpc(async (base) => {
        const r = await fetch(`${base}/extended/v1/tx/${txid}`);
        if (!r.ok) throw new Error(`tx fetch → ${r.status}`);
        return (await r.json()) as { tx_status?: string; tx_result?: { repr?: string } };
      });
      if (j.tx_status && j.tx_status !== "pending") return j;
    } catch {
      // transient — every endpoint down this poll; the next iteration retries
    }
  }
  return { tx_status: "timeout" } as { tx_status: string; tx_result?: { repr?: string } };
}

interface Snapshot {
  midXinY: number;
  inv: Inventory;
  xHuman: number;
  yHuman: number;
  nativeStxMicro: bigint;
  lpBalanceBase: bigint;
  lpValueY: number;
  portfolioY: number;
  externalMid: number | null;
  poolActive: boolean;
  xReserve: number;
  yReserve: number;
  poolFeeBps: number;
  market: MarketState;
}

async function readMarket(w: Wallet): Promise<Snapshot> {
  const cfg = activePool();
  const [pool, xBase, yBase, lp, ext, stx] = await Promise.all([
    getPoolState(contractId(cfg.pool)),
    getTokenBalance(w.address, w.network, cfg.x),
    getTokenBalance(w.address, w.network, cfg.y),
    getLpBalance(w.address, w.network),
    getExternalMid(),
    getStxBalance(w.address, w.network),
  ]);
  const xH = Number(xBase) / 10 ** cfg.x.decimals;
  const yH = Number(yBase) / 10 ** cfg.y.decimals;
  let lpValueY = 0;
  if (lp > 0n) {
    const q = await getWithdrawQuote(lp);
    lpValueY = (Number(q.xOut) / 10 ** cfg.x.decimals) * pool.midXinY + Number(q.yOut) / 10 ** cfg.y.decimals;
  }
  const freeValueY = xH * pool.midXinY + yH;
  const portfolioY = freeValueY + lpValueY;
  const yFraction = freeValueY > 0 ? yH / freeValueY : 0;
  return {
    midXinY: pool.midXinY,
    inv: { xBase, yBase },
    xHuman: xH,
    yHuman: yH,
    nativeStxMicro: stx.microStx,
    lpBalanceBase: lp,
    lpValueY,
    portfolioY,
    externalMid: ext?.midXinY ?? null,
    poolActive: pool.poolActive,
    xReserve: pool.xReserve,
    yReserve: pool.yReserve,
    poolFeeBps: pool.feeBps,
    market: { midXinY: pool.midXinY, yFraction, drift: yFraction - 0.5, totalY: freeValueY },
  };
}

function refuse(why: string): boolean {
  console.log(`  ✗ refusing live trade: ${why}`);
  tickJournal.refused = why;
  return false;
}

async function broadcastResult(built: BuiltTx): Promise<boolean> {
  tickJournal.action = built.action;
  if (!built.broadcast?.txid) {
    console.log(`  ✗ broadcast failed/aborted: ${built.broadcast?.error}`);
    tickJournal.broadcastError = built.broadcast?.error;
    return false;
  }
  console.log(`  ✓ txid: ${built.broadcast.txid} — confirming…`);
  const res = await waitForTx(built.broadcast.txid);
  console.log(`  status: ${res.tx_status}${res.tx_result?.repr ? ` ${res.tx_result.repr}` : ""}`);
  tickJournal.txid = built.broadcast.txid;
  tickJournal.status = res.tx_status;
  return res.tx_status === "success";
}

async function act(
  w: Wallet,
  s: Snapshot,
  params: AgentParams,
  canTrade: boolean,
  sessionStart: number,
  intervalSec: number,
): Promise<boolean> {
  const cfg = activePool();
  const { x, y } = cfg;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[${ts}] mid 1 ${x.symbol} = ${s.midXinY.toLocaleString()} ${y.symbol}`);
  console.log(
    `  free: ${s.xHuman} ${x.symbol} + ${s.yHuman} ${y.symbol} | ` +
      `LP: ${lpH(s.lpBalanceBase).toFixed(6)} (~${s.lpValueY.toFixed(2)} ${y.symbol}) | ` +
      `portfolio ~${s.portfolioY.toFixed(2)} ${y.symbol}`,
  );

  // Oracle-sanity + kill-switch gate.
  const safety = assessSafety(
    {
      poolMid: s.midXinY,
      externalMid: s.externalMid,
      poolActive: s.poolActive,
      portfolioStx: s.portfolioY,
      sessionStartStx: sessionStart,
    },
    defaultSafetyParams(),
  );
  const div = safety.divergenceBps != null ? `${(safety.divergenceBps / 100).toFixed(2)}%` : "n/a";
  console.log(
    `  safety: external ${s.externalMid ? s.externalMid.toLocaleString() : "n/a"} ${y.symbol}/${x.symbol} | divergence ${div} | pool ${s.poolActive ? "active" : "PAUSED"}`,
  );

  // Divergence capture, DETECTION ONLY (see arb.ts): what the optimal pool-vs-reference
  // trade would net after pool fee, FlashStack fee, and gas. Journalled every cycle it
  // exists — the opportunity record that sizes the M2 flash-rebalance work. Runs before
  // the safety gate on purpose: large divergences trip the oracle halt, and those are
  // exactly the opportunities worth having on record.
  let arbOpp = null;
  if (s.externalMid) {
    arbOpp = findArb(s.xReserve, s.yReserve, s.externalMid, {
      poolFeeBps: s.poolFeeBps,
      gasY: y.native ? Number(FEE_USTX) / 1e6 : 0, // gas is STX; only y-denominable when y IS STX
    });
    if (arbOpp) {
      console.log(
        `  arb: ${arbOpp.direction} ${arbOpp.amountIn.toFixed(arbOpp.direction === "buy-x" ? 2 : 8)} → ` +
          `net edge ~${arbOpp.netEdgeY.toFixed(2)} ${y.symbol} at ${(arbOpp.divergenceBps / 100).toFixed(2)}% divergence (detection only)`,
      );
    }
  }

  tickJournal = {
    t: ts,
    pair: cfg.key,
    mode: canTrade ? "live" : "observe",
    mid: +s.midXinY.toFixed(4),
    ext: s.externalMid ? +s.externalMid.toFixed(4) : null,
    portfolioY: +s.portfolioY.toFixed(4),
    lpValueY: +s.lpValueY.toFixed(4),
    safe: safety.safe,
    ...(safety.reasons.length ? { haltReasons: safety.reasons } : {}),
    ...(arbOpp
      ? {
          arb: {
            direction: arbOpp.direction,
            amountIn: +arbOpp.amountIn.toFixed(8),
            netEdgeY: +arbOpp.netEdgeY.toFixed(4),
            divergenceBps: Math.round(arbOpp.divergenceBps),
          },
        }
      : {}),
    params: {
      targetY: params.targetYFraction,
      bandBps: params.rebalanceBandBps,
      slipBps: params.slippageBps,
      targetLp: params.targetLpFraction,
    },
  };

  // Pilot evidence trail: heartbeat + mid + inventory (see metrics.ts).
  recordSample(cfg.key, w.address, intervalSec, {
    t: ts.replace(" ", "T") + "Z",
    mid: s.midXinY,
    ext: s.externalMid,
    xBase: s.inv.xBase.toString(),
    yBase: s.inv.yBase.toString(),
    lpValueY: s.lpValueY,
    portfolioY: s.portfolioY,
    safe: safety.safe,
  });
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

  // 1) LP allocation (earns the pool fee) — only if enabled.
  if (params.targetLpFraction > 0) {
    const lp = decideLp(
      s.portfolioY, s.lpBalanceBase, s.lpValueY,
      s.inv.xBase, s.inv.yBase, s.midXinY, x.decimals, y.decimals, params,
    );
    if (lp.action !== "none") {
      // Exit-liquidity guard: bounded share of the pool, or no growth. See agent.ts.
      if (lp.action === "add-liquidity") {
        const addValueY = 2 * (Number(lp.xBase) / 10 ** x.decimals) * s.midXinY;
        const poolValueY = s.yReserve + s.xReserve * s.midXinY;
        if (exceedsPoolShare(s.lpValueY, addValueY, poolValueY)) {
          console.log(`  LP: skip add — pool-share cap (pool value ~${poolValueY.toFixed(0)} ${y.symbol})`);
          tickJournal.lpDecision = { action: "none", reason: "pool-share cap" };
          return false;
        }
      }
      const detail =
        lp.action === "add-liquidity"
          ? `${Number(lp.xBase) / 10 ** x.decimals} ${x.symbol} (+ paired ${y.symbol})`
          : `${lpH(lp.lpBase)} LP`;
      console.log(`  LP: ${lp.action}  ${detail}  (${lp.reason})`);
      tickJournal.lpDecision = { action: lp.action, detail, reason: lp.reason };
      if (!canTrade) { console.log("  observe mode — not executing"); return false; }
      if (w.network !== "mainnet") return refuse("not mainnet");
      const nativeNeed = FEE_USTX + (lp.action === "add-liquidity" && x.native ? lp.xBase : 0n);
      if (s.nativeStxMicro < nativeNeed) return refuse("insufficient native STX for fee");
      console.log("  → broadcasting…");
      const built =
        lp.action === "add-liquidity"
          ? await buildAddLiquidity(lp.xBase, opts)
          : await buildWithdrawLiquidity(lp.lpBase, opts);
      const ok = await broadcastResult(built);
      if (ok) {
        // Track the position's cost basis (leg quantities) so fees-net-of-IL is
        // measurable. Add: x deposited + equal-value y at execution mid (the pool pulls
        // the paired leg at that ratio). Withdraw: proportional burn of both legs.
        if (lp.action === "add-liquidity") {
          const xQty = Number(lp.xBase) / 10 ** x.decimals;
          adjustLpBasis({ kind: "add", xQty, yQty: xQty * s.midXinY, t: ts.replace(" ", "T") + "Z" });
        } else if (s.lpBalanceBase > 0n) {
          adjustLpBasis({ kind: "withdraw", fraction: Number(lp.lpBase) / Number(s.lpBalanceBase) });
        }
      }
      return ok;
    }
    console.log(`  LP: hold — ${lp.reason}`);
  }

  // 2) Rebalance free inventory via swap.
  const d = decide(s.inv, s.midXinY, x.decimals, y.decimals, params);
  tickJournal.rebalance = { action: d.action, reason: d.reason };
  if (d.action === "none") {
    console.log(`  rebalance: HOLD — ${d.reason}`);
    return false;
  }
  const amt =
    d.action === "swap-y-for-x"
      ? `${Number(d.amountBase) / 10 ** y.decimals} ${y.symbol} → ${x.symbol}`
      : `${Number(d.amountBase) / 10 ** x.decimals} ${x.symbol} → ${y.symbol}`;
  console.log(`  rebalance: ${d.action}  ${amt}  (${d.reason})`);
  if (!canTrade) { console.log("  observe mode — not executing"); return false; }
  if (w.network !== "mainnet") return refuse("not mainnet");
  if (d.action === "swap-y-for-x" && d.amountBase > params.maxSwapYBase) return refuse("y over cap");
  if (d.action === "swap-x-for-y" && d.amountBase > params.maxSwapXBase) return refuse("x over cap");
  // native STX fee headroom (+ input if the input leg is native STX)
  const inputNative = d.action === "swap-y-for-x" ? y.native : x.native;
  const nativeNeed = FEE_USTX + (inputNative ? d.amountBase : 0n);
  if (s.nativeStxMicro < nativeNeed) return refuse("insufficient native STX for amount + fee");
  console.log("  → broadcasting…");
  const built =
    d.action === "swap-y-for-x"
      ? await buildSwapYForX(d.amountBase, opts)
      : await buildSwapXForY(d.amountBase, opts);
  return broadcastResult(built);
}

function printTune(p: TunedParams) {
  console.log(
    `  [AI] regime=${p.regime} → band=${p.rebalanceBandBps}bps, targetY=${p.targetYFraction}, slip=${p.slippageBps}bps` +
      (p.rationale ? `\n       ${p.rationale}` : ""),
  );
}

/**
 * Replace the AI's qualitative band with one measured from realised volatility.
 *
 * Rebalancing pays the pool fee, so the band is a fee budget and belongs in units of
 * volatility (see bandBpsFromVol). The LLM's regime call was a proxy for exactly this;
 * where there is enough history to measure sigma, the measurement wins and the LLM's band
 * stays advisory. Every other AI-proposed parameter is untouched.
 *
 * Returns the params to use plus what happened, so the caller can log both bands side by
 * side — the comparison is the evidence that the deterministic core, not the model, is in
 * control of risk.
 */
function applyVolBand(params: AgentParams): { params: AgentParams; sigmaDaily: number | null; bandBps: number } {
  const history = loadHistory().map((s) => ({ t: s.t, mid: s.mid, lpValueY: s.lpValueY }));
  const sigmaDaily = realizedVolDaily(history);
  if (sigmaDaily === null) return { params, sigmaDaily: null, bandBps: params.rebalanceBandBps };
  const bandBps = bandBpsFromVol(sigmaDaily);
  return { params: { ...params, rebalanceBandBps: bandBps }, sigmaDaily, bandBps };
}

async function main() {
  const f = flags();
  const live = f.live && f.yesMainnet;
  const cfg = activePool();
  console.log(
    `=== DeepStack agent [${cfg.poolSymbol}] — ${live ? "LIVE (executes real txs)" : "OBSERVE (no broadcasting)"} ===`,
  );
  const w = await getWallet();
  console.log(`network: ${w.network} | address: ${w.address}`);
  if (f.live && !f.yesMainnet) console.log("note: --live needs --yes-mainnet; running observe-only.");

  let params: AgentParams = defaultParams();
  if (params.targetLpFraction > 0)
    console.log(`LP enabled: target ${(params.targetLpFraction * 100).toFixed(0)}% of portfolio`);

  let trades = 0;
  let i = 0;
  let sessionStart = 0;
  const step = async () => {
    const snap = await readMarket(w);
    if (sessionStart === 0) sessionStart = snap.portfolioY;
    if (i % f.tuneEvery === 0) {
      const tuned = await tuneParams(snap.market, defaultParams());
      printTune(tuned);
      // Measured volatility overrides the AI's band where history allows; the model's
      // other proposals stand. Deterministic risk control, model-assisted parameters.
      const vol = applyVolBand(tuned);
      params = vol.params;
      if (vol.sigmaDaily === null) {
        console.log(`  [vol] no mid history yet → band=${vol.bandBps}bps (AI advisory, in force)`);
      } else {
        console.log(
          `  [vol] realised ${(vol.sigmaDaily * 100).toFixed(2)}%/day → band=${vol.bandBps}bps (measured, in force)` +
            (vol.bandBps !== tuned.rebalanceBandBps ? ` — overrides AI's ${tuned.rebalanceBandBps}bps` : ""),
        );
      }
      // Evidence that the AI tuning layer is active: regime + rationale + params set.
      appendJournal({
        t: new Date().toISOString(),
        type: "tune",
        regime: tuned.regime,
        rationale: tuned.rationale,
        set: { targetY: tuned.targetYFraction, bandBps: tuned.rebalanceBandBps, slipBps: tuned.slippageBps },
        measured: { sigmaDaily: vol.sigmaDaily, bandBps: vol.bandBps, source: vol.sigmaDaily === null ? "ai" : "vol" },
      });
    }
    i++;
    try {
      if (await act(w, snap, params, live && trades < f.maxTrades, sessionStart, f.interval)) trades++;
    } finally {
      appendJournal(tickJournal); // one journal line per tick, whatever happened
      await pingHealthcheck(); // dead-man's switch: silence = alert
      await publishMetrics(); // pilot telemetry → public dashboard (gist mirror)
    }
  };

  // A cycle depends on third-party reads (chain RPC, price reference, tuner). Over a
  // 30-day pilot those WILL fail transiently; a failed cycle must be a skipped cycle, not
  // a dead agent. Journalled and reported to the dead-man's switch, so a persistent outage
  // is loud rather than silently "live but not trading". See supervise.ts.
  const supervisor = createSupervisor(async ({ error, consecutive }) => {
    console.error(`  ✗ cycle failed (${consecutive} in a row): ${error}`);
    appendJournal({ t: new Date().toISOString(), type: "cycle-error", error, consecutive });
    await pingHealthcheck("fail");
    if (consecutive >= 5)
      console.error(`  ⚠ ${consecutive} consecutive failures — agent is live but not trading. Check RPC/network.`);
  });
  const runStep = () => supervisor.run(step);

  if (f.interval) {
    // Guarded from the first cycle: a blip at startup must not stop the pilot beginning.
    await runStep();
    console.log(`\n(looping every ${f.interval}s — Ctrl+C to stop)`);
    while (true) {
      await sleep(f.interval * 1000);
      if (live && trades >= f.maxTrades) console.log(`\n(reached --max-trades ${f.maxTrades}; observe-only now)`);
      await runStep();
    }
  } else {
    // One-shot: a failure is a failure — surface it and exit non-zero.
    await step();
  }
}

main().catch((err) => {
  console.error("agent failed:", err.message);
  process.exit(1);
});
