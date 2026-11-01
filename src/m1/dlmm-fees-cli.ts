// Fees the concentrated position has actually earned, from chain data (dlmm-fees.ts).
//
//   npm run m1:dlmm-fees -- show                 # fees since the recorded deposit, and per day
//   npm run m1:dlmm-fees -- seed <txid>          # record an existing position's add transaction
//   npm run m1:dlmm-fees -- seed <txid> --replace   # start the record again from this transaction
//
// The agent records every add it makes; `seed` is for a position opened before that existed.
// Read-only on chain: nothing is ever sent.

import { getWallet } from "./wallet.js";
import { DLMM_POOLS } from "./dlmm-read.js";
import { readUserPosition } from "./dlmm-position.js";
import { loadDeposit, clearDeposit, feesEarned } from "./dlmm-fees.js";
import { recordDepositFromTx } from "./dlmm-fees-record.js";

const argv = process.argv.slice(2);
const [cmd, txid] = argv.filter((a) => !a.startsWith("--"));

async function main(): Promise<void> {
  const w = await getWallet();
  const pair = process.env.DLMM_OBSERVE_PAIR ?? "sbtc-usdcx";
  const poolDef = DLMM_POOLS.find((p) => p.key === pair);
  if (!poolDef) throw new Error(`unknown pool ${pair}`);

  if (cmd === "seed") {
    if (!/^0x[0-9a-f]{64}$/.test(txid ?? "")) throw new Error("usage: m1:dlmm-fees -- seed <0x txid> [--replace]");
    if (argv.includes("--replace")) clearDeposit();
    if (loadDeposit()?.txids.includes(txid)) return void console.log("already recorded; nothing to do");
    const ok = await recordDepositFromTx(txid, w.address, pair, (m) => console.log(m));
    if (!ok) process.exitCode = 1;
    return;
  }
  if (cmd !== "show") throw new Error("usage: m1:dlmm-fees -- show | seed <txid> [--replace]");

  const dep = loadDeposit();
  if (!dep || dep.pool !== pair || dep.owner !== w.address) return void console.log("no deposit recorded for this wallet's position (use seed <txid>)");
  const pos = await readUserPosition(poolDef, w.address);
  const f = feesEarned(dep, pos.bins);
  if (!f) return void console.log("the recorded deposit does not match the current position's bins");
  const days = (Date.now() - Date.parse(dep.t)) / 86_400_000;
  const usdcx = (n: bigint) => (Number(n) / 1e6).toFixed(2);
  console.log(`deposit ${dep.t} (${dep.txids.length} add tx), ${f.bins} bins held`);
  console.log(`value at each bin's own price: deposited ${usdcx(f.depositY)}, now ${usdcx(f.nowY)} USDCx`);
  console.log(`fees earned: ${usdcx(f.feesY)} USDCx over ${days.toFixed(2)} days = ${(Number(f.feesY) / 1e6 / days).toFixed(2)} USDCx/day`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
