// The DLMM range-width decision from recorded telemetry (dlmm-width.ts). Read-only.
//
//   npm run m1:dlmm-width                     # from dashboard/metrics.json (on the server: live)
//   npm run m1:dlmm-width -- --url=<metrics.json url>   # e.g. the public gist mirror
//   options: --current=50 (today's half-width) --widths=10,15,20,25,30,35,50 --cost=<usd per recenter>
//
// Fees come from the agent's on-chain measurement (dlmm-fees.ts); impermanent loss is fees minus
// the position's measured result against holding its deposited legs (dlmmBasis).

import { readFileSync } from "node:fs";
import { METRICS_PATH, type MetricsFile } from "./metrics.js";
import { binVolAtHorizon, backtestRecenters, recenterCostUsd, widthTable, recommendWidth, type BinPoint } from "./dlmm-width.js";

const argv = process.argv.slice(2);
const opt = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DAY = 86_400_000;

async function main(): Promise<void> {
  const url = opt("url");
  const m = (url ? await fetch(url).then((r) => r.json()) : JSON.parse(readFileSync(METRICS_PATH, "utf8"))) as MetricsFile;
  const current = Number(opt("current") ?? process.env.DLMM_PIN_HALF_WIDTH ?? 50);
  const widths = [...new Set([...(opt("widths") ?? "10,15,20,25,30,35,50").split(",").map(Number), current])];
  const s = m.samples[m.samples.length - 1];
  const step = s.dlmmBinStep;
  const pts: BinPoint[] = m.samples
    .filter((x) => x.dlmmActiveBin != null && x.dlmmActiveBin >= 0 && x.dlmmBinStep === step)
    .map((x) => ({ t: Date.parse(x.t) / DAY, bin: x.dlmmActiveBin! }));
  if (pts.length < 48) throw new Error("not enough bin history yet");
  const spanDays = pts[pts.length - 1].t - pts[0].t;

  if (!m.dlmmFees) throw new Error("no on-chain fee figure yet (seed the deposit: npm run m1:dlmm-fees -- seed <txid>)");
  if (!m.dlmmBasis || !s.dlmmValueY || !s.stxUsd) throw new Error("no DLMM basis or value in the latest sample");
  const feeDays = (Date.parse(m.dlmmFees.t) - Date.parse(m.dlmmFees.since)) / DAY;
  const feesPerDay = m.dlmmFees.usdcx / feeDays;
  const b = m.dlmmBasis;
  const netDays = (Date.parse(s.t) - Date.parse(b.t)) / DAY;
  const netUsd = (s.dlmmValueY - (b.xQty * s.mid + b.yQty / s.stxUsd)) * s.stxUsd;
  const netPerDay = netUsd / netDays;
  const ilPerDay = feesPerDay - netPerDay;
  const positionUsd = s.dlmmValueY * s.stxUsd;
  const cost = Number(opt("cost") ?? recenterCostUsd(positionUsd));

  const f = (n: number) => n.toFixed(2);
  console.log(`telemetry ${m.updated} · position $${f(positionUsd)} at ±${current} · bin step ${step} bps`);
  console.log(`fees (on chain): $${f(m.dlmmFees.usdcx)} over ${f(feeDays)} days = $${f(feesPerDay)}/day`);
  console.log(`result vs holding: $${f(netUsd)} over ${f(netDays)} days = $${f(netPerDay)}/day, so impermanent loss ≈ $${f(ilPerDay)}/day`);
  const vol = (d: number) => { const v = binVolAtHorizon(pts, d); return v == null ? "n/a" : `${f(v * step! / 100)}%/day`; };
  console.log(`price volatility over ${f(spanDays)} days: 30 min ${vol(1 / 48)} · 6 h ${vol(0.25)} · 1 day ${vol(1)}`);
  console.log(`recenter cost ≈ $${f(cost)} (half the position at the 0.5% pool fee, plus gas)\n`);

  const rows = widthTable({ feesPerDay, ilPerDay, currentHalfWidth: current, spanDays, costUsd: cost, recenters: new Map(widths.map((h) => [h, backtestRecenters(pts, h)])) });
  console.log("width   recenters  fees/day  IL/day  recenter/day  net/day");
  for (const r of rows) {
    console.log(`±${String(r.halfWidth).padEnd(5)} ${String(r.recenters).padStart(9)}  ${f(r.feesPerDay).padStart(8)}  ${f(r.ilPerDay).padStart(6)}  ${f(r.recenterPerDay).padStart(12)}  ${f(r.netPerDay).padStart(7)}`);
  }
  const rec = recommendWidth(rows, current);
  console.log(`\nrecommendation: ±${rec.halfWidth} (${rec.reason})`);
  console.log("assumes our share of liquidity near the price stays small, so fees and IL scale with concentration; recenters replayed on the recorded path.");
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
