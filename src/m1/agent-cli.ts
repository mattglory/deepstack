// DeepStack agent loop — OBSERVE mode (read → decide → log). No broadcasting.
//
// Each cycle: read the on-chain pool mid + your wallet inventory, run the
// deterministic decision core, and log what it WOULD do. Execution reuses the
// already-validated guarded action builders and is intentionally not wired here
// (observe-only) — flip to live as a deliberate next step.
//
//   npm run m1:agent                 # one observe cycle
//   npm run m1:agent -- --interval 30  # loop every 30s (still observe-only)

import { getWallet, getStxBalance, getSbtcBalance } from "./wallet.js";
import { getPoolState } from "../pool.js";
import { decide, defaultParams, type Inventory } from "./agent.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseInterval(): number | null {
  const a = process.argv.slice(2);
  const i = a.indexOf("--interval");
  if (i === -1) return null;
  const n = Number(a[i + 1]);
  return n > 0 ? n : null;
}

async function cycle(address: string, network: "mainnet" | "testnet") {
  const params = defaultParams();
  // Pool is mainnet-only; inventory is read on the wallet's network.
  const [pool, stx, sbtc] = await Promise.all([
    getPoolState("SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1"),
    getStxBalance(address, network),
    getSbtcBalance(address, network),
  ]);
  const inv: Inventory = { sbtcBase: sbtc, stxMicro: stx.microStx };
  const d = decide(inv, pool.midXinY, params);

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[${ts}] mid 1 sBTC = ${pool.midXinY.toLocaleString()} STX`);
  console.log(
    `  inventory: ${(Number(sbtc) / 1e8).toFixed(8)} sBTC + ${stx.stx} STX  ` +
      `(${(d.metrics.stxFraction * 100).toFixed(1)}% STX / ${((1 - d.metrics.stxFraction) * 100).toFixed(1)}% sBTC, total ≈ ${d.metrics.totalStx.toLocaleString(undefined, { maximumFractionDigits: 0 })} STX)`,
  );
  if (d.action === "none") {
    console.log(`  decision: HOLD — ${d.reason}`);
  } else {
    const amt =
      d.action === "swap-y-for-x"
        ? `${Number(d.amountBase) / 1e6} STX → sBTC`
        : `${Number(d.amountBase) / 1e8} sBTC → STX`;
    console.log(`  decision: ${d.action}  ${amt}`);
    console.log(`  reason:   ${d.reason}`);
    console.log(`  (observe mode — would execute via the guarded action builders)`);
  }
}

async function main() {
  console.log("=== DeepStack agent — OBSERVE mode (no broadcasting) ===");
  const w = await getWallet();
  console.log(`network: ${w.network} | address: ${w.address}`);
  const interval = parseInterval();

  await cycle(w.address, w.network);
  if (interval) {
    console.log(`\n(looping every ${interval}s — Ctrl+C to stop)`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await sleep(interval * 1000);
      await cycle(w.address, w.network).catch((e) => console.error("cycle error:", e.message));
    }
  }
}

main().catch((err) => {
  console.error("agent failed:", err.message);
  process.exit(1);
});
