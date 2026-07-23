// Haven rotation — the FULL capital-preservation reflex: rotate into a stablecoin (USDCx)
// during defensive regimes, so a bear market can't erode the book.
//
// This is the real thing the within-pair sBTC skew (allocation.ts) only approximates. The
// safe asset is a STABLECOIN because it holds value when everything else falls. The decision
// logic and route-readiness detection are built and tested here — but EXECUTION IS DORMANT
// until a liquid USDCx route exists AND an adapter can reach it.
//
// Status 2026-07-22: a real STX-USDCx pool now exists on the DLMM concentrated-liquidity venue
// (~$211k, actively traded). It is NOT yet usable for two reasons:
// (1) ~$211k is still below HAVEN_MIN_LIQ_USD ($250k), and concentrated (bin) depth can slip
// harder than the headline number; (2) it is a DLMM venue — the XYK adapter can't route bins,
// so a DLMM swap adapter is a prerequisite. Rotating into a too-thin or unreachable pool would
// eat catastrophic slippage — protection that fails exactly when needed. So this arms and waits:
// it says WHAT it would do and WHETHER a route is ready, and does nothing until both land.
//
// When the pool clears the floor and the DLMM adapter exists, a HavenRoute is configured and the
// same logic activates — no rewrite, just a plugged-in execution path.

import type { Regime } from "./allocation.js";

export interface HavenParams {
  havenAsset: string; // symbol of the stablecoin haven (default USDCx)
  defensiveHavenFraction: number; // portfolio fraction to hold in the haven when defensive
  elevatedHavenFraction: number; // smaller cushion when elevated
  minRouteLiquidityUsd: number; // a route below this is not viable (would slip badly)
}

export function defaultHavenParams(): HavenParams {
  return {
    havenAsset: process.env.HAVEN_ASSET ?? "USDCx",
    defensiveHavenFraction: Number(process.env.HAVEN_DEFENSIVE_FRACTION ?? 0.4),
    elevatedHavenFraction: Number(process.env.HAVEN_ELEVATED_FRACTION ?? 0.15),
    minRouteLiquidityUsd: Number(process.env.HAVEN_MIN_LIQ_USD ?? 250_000),
  };
}

/** Target fraction of the portfolio to hold in the stablecoin haven, by regime. */
export function havenTargetFraction(regime: Regime, p: HavenParams): number {
  const f =
    regime === "defensive" ? p.defensiveHavenFraction : regime === "elevated" ? p.elevatedHavenFraction : 0;
  return Math.min(1, Math.max(0, f));
}

export interface HavenPool {
  pool: string;
  liqUsd: number;
}

export interface HavenReadiness {
  ready: boolean;
  route: string | null; // the pool that would be used, if any
  reason: string;
}

/**
 * Is there a viable route into the haven asset? A route is a pool that (a) pairs the haven
 * asset and (b) has enough liquidity that rotating into it won't slip catastrophically.
 * Pure over the pool list the scanner already collects — the trigger that flips haven
 * rotation from dormant to live.
 */
export function havenRouteReady(pools: HavenPool[], p: HavenParams): HavenReadiness {
  const haven = p.havenAsset.toLowerCase();
  const candidates = pools
    .filter((pl) => pl.pool.toLowerCase().includes(haven) && pl.liqUsd >= p.minRouteLiquidityUsd)
    .sort((a, b) => b.liqUsd - a.liqUsd);
  if (candidates.length === 0) {
    const best = pools.filter((pl) => pl.pool.toLowerCase().includes(haven)).sort((a, b) => b.liqUsd - a.liqUsd)[0];
    return {
      ready: false,
      route: null,
      reason: best
        ? `deepest ${p.havenAsset} pool ${best.pool} is $${Math.round(best.liqUsd).toLocaleString()} < $${p.minRouteLiquidityUsd.toLocaleString()} min — dormant`
        : `no ${p.havenAsset} pool found — dormant`,
    };
  }
  return { ready: true, route: candidates[0].pool, reason: `route ready: ${candidates[0].pool} ($${Math.round(candidates[0].liqUsd).toLocaleString()})` };
}

export interface HavenIntent {
  regime: Regime;
  targetHavenFraction: number;
  ready: boolean;
  route: string | null;
  status: string;
}

/** What haven rotation intends this cycle — armed, but only actionable when a route is ready. */
export function decideHaven(regime: Regime, pools: HavenPool[], p: HavenParams): HavenIntent {
  const target = havenTargetFraction(regime, p);
  const r = havenRouteReady(pools, p);
  const status =
    target === 0
      ? `no haven needed (${regime})`
      : r.ready
        ? `WOULD rotate ${(target * 100).toFixed(0)}% → ${p.havenAsset} via ${r.route}`
        : `armed: want ${(target * 100).toFixed(0)}% ${p.havenAsset} but ${r.reason}`;
  return { regime, targetHavenFraction: target, ready: r.ready, route: r.route, status };
}
