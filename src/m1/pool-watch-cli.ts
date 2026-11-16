// Read-only watch on candidate HODLMM pools (pool-watch.ts). Nothing is ever sent.
//
//   npm run m1:pool-watch                        # default: Bitflow STX/sBTC (bin step 15)
//   npm run m1:pool-watch -- --pool=<contract name> --window=20
//
// Appends each reading to journal/pool-watch.jsonl, so the next run can measure activity. Meant to
// run once a day, for example from cron on the server:
//   0 9 * * * cd /opt/deepstack && node --import tsx src/m1/pool-watch-cli.ts >> journal/pool-watch.log 2>&1

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { loadDotenv } from "./wallet.js";
import { readDlmmState, readLocalDepth } from "./dlmm-read.js";
import { resolveToken, priceOfToken } from "./dlmm-recenter-exec.js";
import { verdict, type WatchObs } from "./pool-watch.js";

const PATH = process.env.POOL_WATCH_PATH ?? "journal/pool-watch.jsonl";
const opt = (k: string) => process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

async function main(): Promise<void> {
  loadDotenv();
  const name = opt("pool") ?? "dlmm-pool-stx-sbtc-v-1-bps-15";
  const windowBins = Number(opt("window") ?? 20);
  const pool = { key: name, name };
  const st = await readDlmmState(pool);
  if (!st) throw new Error(`could not read ${name}`);
  const [xTok, yTok] = await Promise.all([resolveToken(st.xToken), resolveToken(st.yToken)]);
  const [xUsd, yUsd] = await Promise.all([priceOfToken(xTok), priceOfToken(yTok)]);
  const d = await readLocalDepth(pool, st.activeBinId, windowBins);
  const nearDepthUsd = (Number(d.xTotal) / 10 ** xTok.decimals) * xUsd + (Number(d.yTotal) / 10 ** yTok.decimals) * yUsd;
  const obs: WatchObs = { t: new Date().toISOString(), pool: name, activeBin: st.activeBinId, binChangeCount: st.binChangeCount, nearDepthUsd: Math.round(nearDepthUsd), windowBins };

  const prev = existsSync(PATH)
    ? (readFileSync(PATH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as WatchObs).filter((x) => x.pool === name).pop() ?? null)
    : null;
  const v = verdict(obs, prev);
  mkdirSync("journal", { recursive: true });
  appendFileSync(PATH, JSON.stringify(obs) + "\n");
  console.log(`${obs.t} ${name}: active bin ${obs.activeBin}, $${obs.nearDepthUsd.toLocaleString("en")} within ±${windowBins} bins, ${v.binChangesPerDay === null ? "activity n/a" : `${v.binChangesPerDay.toFixed(1)} bin moves/day`}, max position under the 10% cap $${Math.round(v.maxPositionUsd)}`);
  console.log(v.ready ? "READY: deep and active enough for a closer look" : `not ready: ${v.reasons.join("; ")}`);
}

main().catch((e) => { console.error(`error: ${(e as Error).message}`); process.exitCode = 1; });
