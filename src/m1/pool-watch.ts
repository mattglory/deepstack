// A read-only watch on candidate HODLMM pools: is a pool deep and active enough that DeepStack
// could add a position without dominating it? Pure verdict logic; pool-watch-cli.ts does the reads.
//
// Started 2026-11-06 for Bitflow's STX/sBTC pool (bin step 15), which then held only about $1,100
// within ±3% of the price: a ~$600 position would have been 35–50% of it, far above the agent's
// 10% pool-share cap.

export interface WatchObs {
  t: string; // ISO time of the read
  pool: string;
  activeBin: number;
  binChangeCount: number; // the pool's lifetime counter of active-bin moves: a cheap activity proxy
  nearDepthUsd: number; // liquidity within the window around the active bin
  windowBins: number;
}

export interface WatchVerdict {
  binChangesPerDay: number | null; // from the previous observation of the same pool
  maxPositionUsd: number; // the largest position that stays within the pool-share cap
  ready: boolean;
  reasons: string[];
}

export function verdict(
  obs: WatchObs,
  prev: WatchObs | null,
  opts: { minDepthUsd?: number; minBinChangesPerDay?: number; poolShareCap?: number; wantedUsd?: number } = {},
): WatchVerdict {
  const minDepth = opts.minDepthUsd ?? 10_000, minActivity = opts.minBinChangesPerDay ?? 20, cap = opts.poolShareCap ?? 0.1, wanted = opts.wantedUsd ?? 600;
  const days = prev ? (Date.parse(obs.t) - Date.parse(prev.t)) / 86_400_000 : 0;
  const binChangesPerDay = prev && prev.pool === obs.pool && days >= 0.25 ? (obs.binChangeCount - prev.binChangeCount) / days : null;
  // Our position counts toward the depth it would sit in: share = p / (depth + p) <= cap.
  const maxPositionUsd = (cap * obs.nearDepthUsd) / (1 - cap);
  const reasons: string[] = [];
  if (obs.nearDepthUsd < minDepth) reasons.push(`only $${Math.round(obs.nearDepthUsd).toLocaleString("en")} within ±${obs.windowBins} bins (want $${minDepth.toLocaleString("en")})`);
  if (maxPositionUsd < wanted) reasons.push(`a $${wanted} position would exceed the ${cap * 100}% pool-share cap (max now $${Math.round(maxPositionUsd)})`);
  if (binChangesPerDay === null) reasons.push("activity not measured yet (needs a second read at least 6 hours later)");
  else if (binChangesPerDay < minActivity) reasons.push(`only ${binChangesPerDay.toFixed(1)} price-bin moves a day (want ${minActivity})`);
  return { binChangesPerDay, maxPositionUsd, ready: reasons.length === 0, reasons };
}
