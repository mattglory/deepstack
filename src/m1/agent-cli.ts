// DeepStack agent loop — read → (AI-tune on a cadence) → decide → (optionally) act.
//
// Modes:
//   OBSERVE (default): read mid+inventory, decide, log. Nothing broadcasts.
//   LIVE: execute the rebalance swap — requires BOTH --live AND --yes-mainnet,
//         STACKS_NETWORK=mainnet, passes hard caps, waits for each tx to confirm
//         before the next cycle, capped at --max-trades per run.
//
// AI tuning: if OPENROUTER_API_KEY is set, params are tuned every --tune-every
// cycles (default 10). The LLM is off the hot path and its output is clamped;
// without a key the agent uses safe deterministic defaults.
//
//   npm run m1:agent
//   npm run m1:agent -- --interval 30
//   npm run m1:agent -- --live --yes-mainnet --interval 60 --max-trades 3

import { getWallet, getStxBalance, getSbtcBalance, type Wallet } from "./wallet.js";
import { getPoolState } from "../pool.js";
import { buildSwapYForX, buildSwapXForY } from "./actions.js";
import { decide, defaultParams, type Inventory, type AgentParams } from "./agent.js";
import { tuneParams, type MarketState, type TunedParams } from "./ai/tune.js";

const POOL_ID = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1";
const CAP_STX_USTX = 25_000_000n; // 25 STX
const CAP_SBTC_BASE = 50_000n; // 0.0005 sBTC
const FEE_USTX = 50_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  inv: Inventory;
  stxHuman: number;
  sbtcHuman: number;
  market: MarketState;
}

async function readMarket(w: Wallet): Promise<Snapshot> {
  const [pool, stx, sbtc] = await Promise.all([
    getPoolState(POOL_ID),
    getStxBalance(w.address, w.network),
    getSbtcBalance(w.address, w.network),
  ]);
  const sbtcValueStx = (Number(sbtc) / 1e8) * pool.midXinY;
  const total = sbtcValueStx + stx.stx;
  const stxFraction = total > 0 ? stx.stx / total : 0;
  return {
    midXinY: pool.midXinY,
    inv: { sbtcBase: sbtc, stxMicro: stx.microStx },
    stxHuman: stx.stx,
    sbtcHuman: Number(sbtc) / 1e8,
    market: { midXinY: pool.midXinY, stxFraction, drift: stxFraction - 0.5, totalStx: total },
  };
}

// Returns true if a live trade was executed.
async function act(
  w: Wallet,
  s: Snapshot,
  params: AgentParams,
  canTrade: boolean,
): Promise<boolean> {
  const d = decide(s.inv, s.midXinY, params);
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[${ts}] mid 1 sBTC = ${s.midXinY.toLocaleString()} STX`);
  console.log(
    `  inventory: ${s.sbtcHuman.toFixed(8)} sBTC + ${s.stxHuman} STX  ` +
      `(${(d.metrics.stxFraction * 100).toFixed(1)}% STX / ${((1 - d.metrics.stxFraction) * 100).toFixed(1)}% sBTC)`,
  );
  if (d.action === "none") {
    console.log(`  decision: HOLD — ${d.reason}`);
    return false;
  }
  const amtHuman =
    d.action === "swap-y-for-x"
      ? `${Number(d.amountBase) / 1e6} STX → sBTC`
      : `${Number(d.amountBase) / 1e8} sBTC → STX`;
  console.log(`  decision: ${d.action}  ${amtHuman}  (${d.reason})`);

  if (!canTrade) {
    console.log("  observe mode — not executing (add --live --yes-mainnet to act)");
    return false;
  }
  if (w.network !== "mainnet") return refuse("network is not mainnet");
  if (d.action === "swap-y-for-x" && d.amountBase > CAP_STX_USTX) return refuse("STX over hard cap");
  if (d.action === "swap-x-for-y" && d.amountBase > CAP_SBTC_BASE) return refuse("sBTC over hard cap");
  if (d.action === "swap-y-for-x" && s.inv.stxMicro < d.amountBase + FEE_USTX)
    return refuse("insufficient STX for amount + fee");

  console.log("  → broadcasting…");
  const opts = {
    senderKey: w.key,
    network: "mainnet" as const,
    broadcast: true,
    slippageBps: params.slippageBps,
    feeMicroStx: FEE_USTX,
  };
  const built =
    d.action === "swap-y-for-x"
      ? await buildSwapYForX(d.amountBase, opts)
      : await buildSwapXForY(d.amountBase, opts);
  if (!built.broadcast?.txid) {
    console.log(`  ✗ broadcast failed/aborted: ${built.broadcast?.error}`);
    return false;
  }
  console.log(`  ✓ txid: ${built.broadcast.txid} — waiting for confirmation…`);
  const res = await waitForTx(built.broadcast.txid);
  console.log(`  status: ${res.tx_status}${res.tx_result?.repr ? ` ${res.tx_result.repr}` : ""}`);
  return res.tx_status === "success";
}

function refuse(why: string): boolean {
  console.log(`  ✗ refusing live trade: ${why}`);
  return false;
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
    `=== DeepStack agent — ${live ? "LIVE (executes real swaps)" : "OBSERVE (no broadcasting)"} ===`,
  );
  const w = await getWallet();
  console.log(`network: ${w.network} | address: ${w.address}`);
  if (f.live && !f.yesMainnet)
    console.log("note: --live needs --yes-mainnet to actually execute; running observe-only.");

  let params: AgentParams = defaultParams();
  let trades = 0;
  let i = 0;

  const step = async () => {
    const snap = await readMarket(w);
    if (i % f.tuneEvery === 0) {
      const tuned = await tuneParams(snap.market, defaultParams());
      params = tuned;
      printTune(tuned);
    }
    i++;
    const traded = await act(w, snap, params, live && trades < f.maxTrades);
    if (traded) trades++;
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
