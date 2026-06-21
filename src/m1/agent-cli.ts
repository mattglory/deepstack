// DeepStack agent loop — read → decide → (optionally) act.
//
// Modes:
//   OBSERVE (default): read mid+inventory, decide, log. Nothing broadcasts.
//   LIVE: actually execute the rebalance swap — requires BOTH --live AND
//         --yes-mainnet, STACKS_NETWORK=mainnet, passes hard caps, and waits for
//         each tx to confirm before the next cycle (no double-trading on stale
//         balances). At most --max-trades executions per run (default 1).
//
//   npm run m1:agent                                  # one observe cycle
//   npm run m1:agent -- --interval 30                 # observe loop
//   npm run m1:agent -- --live --yes-mainnet          # one live rebalance (if needed)
//   npm run m1:agent -- --live --yes-mainnet --interval 60 --max-trades 3

import { getWallet, getStxBalance, getSbtcBalance, type Wallet } from "./wallet.js";
import { getPoolState } from "../pool.js";
import { buildSwapYForX, buildSwapXForY } from "./actions.js";
import { decide, defaultParams, type Inventory } from "./agent.js";

const POOL_ID = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1";

// Absolute ceilings (defence-in-depth beyond the agent's own param caps).
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
  };
}

async function waitForTx(txid: string, network: "mainnet" | "testnet") {
  const base = network === "mainnet" ? "https://api.mainnet.hiro.so" : "https://api.testnet.hiro.so";
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const r = await fetch(`${base}/extended/v1/tx/${txid}`);
    if (r.ok) {
      const j = (await r.json()) as { tx_status?: string; tx_result?: { repr?: string } };
      if (j.tx_status && j.tx_status !== "pending") return j;
    }
  }
  return { tx_status: "timeout" };
}

// Returns true if a live trade was executed.
async function cycle(w: Wallet, canTrade: boolean): Promise<boolean> {
  const params = defaultParams();
  const [pool, stx, sbtc] = await Promise.all([
    getPoolState(POOL_ID),
    getStxBalance(w.address, w.network),
    getSbtcBalance(w.address, w.network),
  ]);
  const inv: Inventory = { sbtcBase: sbtc, stxMicro: stx.microStx };
  const d = decide(inv, pool.midXinY, params);

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[${ts}] mid 1 sBTC = ${pool.midXinY.toLocaleString()} STX`);
  console.log(
    `  inventory: ${(Number(sbtc) / 1e8).toFixed(8)} sBTC + ${stx.stx} STX  ` +
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

  // --- live execution guards ---
  if (w.network !== "mainnet") {
    console.log("  ✗ refusing live trade: network is not mainnet");
    return false;
  }
  if (d.action === "swap-y-for-x" && d.amountBase > CAP_STX_USTX) {
    console.log("  ✗ refusing: STX amount over hard cap");
    return false;
  }
  if (d.action === "swap-x-for-y" && d.amountBase > CAP_SBTC_BASE) {
    console.log("  ✗ refusing: sBTC amount over hard cap");
    return false;
  }
  if (d.action === "swap-y-for-x" && stx.microStx < d.amountBase + FEE_USTX) {
    console.log("  ✗ refusing: insufficient STX for amount + fee");
    return false;
  }

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
  const res = (await waitForTx(built.broadcast.txid, "mainnet")) as any;
  console.log(`  status: ${res.tx_status}${res.tx_result?.repr ? ` ${res.tx_result.repr}` : ""}`);
  return res.tx_status === "success";
}

async function main() {
  const f = flags();
  const live = f.live && f.yesMainnet;
  console.log(
    `=== DeepStack agent — ${live ? "LIVE (executes real swaps)" : "OBSERVE (no broadcasting)"} ===`,
  );
  const w = await getWallet();
  console.log(`network: ${w.network} | address: ${w.address}`);
  if (f.live && !f.yesMainnet) {
    console.log("note: --live needs --yes-mainnet to actually execute; running observe-only.");
  }

  let trades = 0;
  const tradedThisCycle = await cycle(w, live && trades < f.maxTrades);
  if (tradedThisCycle) trades++;

  if (f.interval) {
    console.log(`\n(looping every ${f.interval}s — Ctrl+C to stop)`);
    while (true) {
      if (live && trades >= f.maxTrades) {
        console.log(`\nreached --max-trades ${f.maxTrades}; switching to observe-only.`);
      }
      await sleep(f.interval * 1000);
      const traded = await cycle(w, live && trades < f.maxTrades).catch((e) => {
        console.error("cycle error:", e.message);
        return false;
      });
      if (traded) trades++;
    }
  }
}

main().catch((err) => {
  console.error("agent failed:", err.message);
  process.exit(1);
});
