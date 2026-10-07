// V1 capital allocator — live report. Reads the agent's own recorded telemetry (same source
// the dashboard's LP/DLMM P&L cards use) and prints a RECOMMENDATION for how capital should
// split across venues. It never moves funds, calls a contract, or writes a config file —
// see capital-allocator.ts's header for why this is semi-automated by design.
//
//   npm run m1:allocator
//
// Output: per-venue current vs. recommended allocation, whether the change needs your
// explicit approval (see ALLOC_MAX_CHANGE), and the exact config you'd set to apply it --
// applying it is always a separate, deliberate step you take, never something this prints
// and then does.

import { loadHistory, loadVenueBases, type MetricsFile, type MetricsSample } from "./metrics.js";
import { decideAllocation, defaultAllocatorParams, type VenueState } from "./capital-allocator.js";
// dashboard/pnl-math.js is a plain, DOM-free ES module -- importable from Node the same way
// the dashboard imports it in the browser. One formula, two consumers, see its own header.
import { organicApr } from "../../dashboard/pnl-math.js";

// Same gist mirror the dashboard itself reads (dashboard/index.html's CFG.metricsMirror) --
// a LOCAL dashboard/metrics.json is almost always stale on a laptop (the real telemetry only
// accumulates where the agent actually runs, the VPS). Default to the real, live mirror
// rather than silently recommending off a dev-machine artifact; ALLOC_METRICS_SOURCE=local
// opts back into the local file (e.g. for running this directly on the VPS itself, where the
// local file IS the live one).
const METRICS_MIRROR_URL = "https://gist.githubusercontent.com/mattglory/1a5267576ac7629c15917ebb211f849f/raw/metrics.json";

const fmtStx = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

async function loadLiveState(): Promise<{ latest: MetricsSample; lpBasis?: MetricsFile["lpBasis"]; dlmmBasis?: MetricsFile["dlmmBasis"]; source: string }> {
  if ((process.env.ALLOC_METRICS_SOURCE ?? "remote").toLowerCase() === "local") {
    const history = loadHistory();
    const latest = history[history.length - 1];
    if (!latest) throw new Error("no local telemetry yet (dashboard/metrics.json is empty) -- run the agent at least once first, or unset ALLOC_METRICS_SOURCE to read the live remote mirror instead");
    const { lpBasis, dlmmBasis } = loadVenueBases();
    return { latest, lpBasis, dlmmBasis, source: "local dashboard/metrics.json" };
  }
  const res = await fetch(`${METRICS_MIRROR_URL}?t=${Date.now()}`); // cache-bust -- this is a live decision, not a cached page load
  if (!res.ok) throw new Error(`metrics mirror fetch failed: ${res.status} -- set ALLOC_METRICS_SOURCE=local to use the local file instead`);
  const m = (await res.json()) as MetricsFile;
  const latest = m.samples?.[m.samples.length - 1];
  if (!latest) throw new Error("metrics mirror has no samples yet");
  return { latest, lpBasis: m.lpBasis, dlmmBasis: m.dlmmBasis, source: "live gist mirror" };
}

async function main() {
  console.log("=== DeepStack — V1 capital allocator (recommendation only) ===\n");

  const { latest, lpBasis, dlmmBasis, source } = await loadLiveState();
  console.log(`Data source: ${source}\n`);

  const lpValueY = latest.lpValueY ?? 0;
  const dlmmValueY = latest.dlmmValueY ?? 0;
  const portfolioY = latest.portfolioY ?? 0;

  const xyk = organicApr(
    lpBasis && latest.mid > 0
      ? { currentValueY: lpValueY, basisXQty: lpBasis.xQty, basisYQty: lpBasis.yQty, basisT: lpBasis.t, mid: latest.mid }
      : { currentValueY: 0, basisXQty: null as unknown as number, basisYQty: 0, basisT: "", mid: 0 },
  );
  const dlmm = organicApr(
    dlmmBasis && latest.mid > 0 && (latest.stxUsd ?? 0) > 0
      ? { currentValueY: dlmmValueY, basisXQty: dlmmBasis.xQty, basisYQty: dlmmBasis.yQty, basisT: dlmmBasis.t, mid: latest.mid, yLegUsdRate: latest.stxUsd }
      : { currentValueY: 0, basisXQty: null as unknown as number, basisYQty: 0, basisT: "", mid: 0 },
  );

  const venues: VenueState[] = [
    {
      key: "xyk-sbtc-stx",
      currentValueY: lpValueY,
      trailingOrganicAprPct: xyk.apr,
      incentiveEligible: false, // confirmed via research: the Endowment's BTC program covers sBTC/USDCx and STX/USDCx only
      maxCapFraction: Number(process.env.ALLOC_XYK_MAX_CAP ?? 0.45),
    },
    {
      key: "dlmm-sbtc-usdcx",
      currentValueY: dlmmValueY,
      trailingOrganicAprPct: dlmm.apr,
      incentiveEligible: true, // confirmed via research: this exact pair qualifies for the 0.5 BTC/month program
      maxCapFraction: Number(process.env.ALLOC_DLMM_MAX_CAP ?? 0.25),
    },
  ];

  const params = defaultAllocatorParams();
  const decision = decideAllocation(venues, portfolioY, params);

  console.log(`Total portfolio: ${fmtStx(portfolioY)} STX`);
  console.log(`Reserve floor: ${fmtPct(params.reserveFloorFraction)} | Total LP budget: ${fmtPct(decision.totalLpBudgetFraction)} (${fmtStx(decision.totalLpBudgetFraction * portfolioY)} STX)\n`);

  for (const v of decision.venues) {
    console.log(`[${v.key}]`);
    console.log(`  current:     ${fmtStx(v.currentFraction * decision.totalPortfolioY)} STX (${fmtPct(v.currentFraction)} of portfolio)`);
    console.log(`  recommended: ${fmtStx(v.recommendedValueY)} STX (${fmtPct(v.recommendedFraction)} of portfolio, cap ${fmtPct(v.effectiveCapFraction)})`);
    console.log(`  change:      ${v.changeFraction >= 0 ? "+" : ""}${fmtPct(v.changeFraction)} of portfolio${v.requiresApproval ? "  ⚠ requires explicit approval" : ""}`);
    console.log(`  reason:      ${v.reason}\n`);
  }

  const anyApproval = decision.venues.some((v) => v.requiresApproval);
  if (anyApproval) {
    console.log("One or more venues need an explicit decision before anything changes -- this tool never applies a recommendation on its own.");
  } else {
    console.log("All recommended changes are within the auto threshold -- still nothing applied automatically; wiring this into the live agent is a separate, later step.");
  }
}

main().catch((err) => {
  console.error("allocator-cli failed:", err.message);
  process.exit(1);
});
