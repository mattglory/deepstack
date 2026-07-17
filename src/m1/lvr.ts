// Loss-versus-rebalancing (LVR) — what providing liquidity actually costs.
//
// An AMM always quotes a stale price relative to faster venues. When the external price
// moves, arbitrageurs trade against the pool before it catches up, and the LP is on the
// losing side of every one of those trades. LVR is the precise measure of that adverse
// selection: the gap between an LP position and the same exposure rebalanced at the
// external price. It is the cost the pool fee has to cover before LPing earns anything.
//
// Milionis, Roughgarden, Moallemi & Zhang (2022), "Automated Market Making and
// Loss-Versus-Rebalancing" (arXiv:2208.06046) give the closed form for a constant-product
// pool: instantaneous LVR, normalised by pool value, is exactly
//
//     sigma^2 / 8
//
// per unit time. (Sanity check against a16z's worked example: sigma = 5%/day implies
// 0.05^2 / 8 = 3.125 bps of pool value lost per day.)
//
// Discretising over a sample interval where the mid moved by log-return r, sigma^2 * dt
// is estimated by r^2, so the LVR incurred over that interval is approximately
//
//     (r^2 / 8) * lpValue
//
// which is what this module sums. Pure functions, no I/O — same contract as agent.ts, so
// the numbers are reproducible and testable.
//
// LIMITS, STATED HONESTLY:
//  - The closed form assumes continuous arbitrage, frictionless arbs and GBM. Real pools
//    have a fee that gates small arbs, so this is a model estimate, not a measurement.
//  - Realised variance from sparse samples UNDER-estimates true variance: moves that
//    round-trip between two heartbeats are invisible. Treat the output as a lower bound,
//    and sample faster if you want it tighter.
//  - It says nothing about fee income. Use breakEvenDailyVolume() for the other half.

export interface MidPoint {
  t: string; // ISO timestamp
  mid: number; // pool mid, y per 1 x
  lpValueY: number; // LP position value in y at that moment (0 when not providing)
}

export interface LvrEstimate {
  samples: number; // intervals used (samples - 1)
  windowDays: number;
  sigmaDaily: number | null; // realised daily volatility of the pool mid
  lvrRateBpsPerDay: number | null; // sigma^2/8, in bps of LP value per day
  cumulativeLvrY: number; // modelled LVR over the window, in y units
}

const MS_PER_DAY = 86_400_000;

// Consecutive intervals with a positive time gap and usable mids.
function intervals(points: MidPoint[]): { r: number; dtDays: number; lpValueY: number }[] {
  const out: { r: number; dtDays: number; lpValueY: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (!(a.mid > 0) || !(b.mid > 0)) continue;
    const dtDays = (new Date(b.t).getTime() - new Date(a.t).getTime()) / MS_PER_DAY;
    if (!(dtDays > 0)) continue; // out-of-order or duplicate timestamps
    // LP value is taken at the START of the interval: that's the capital exposed to the
    // move, before any rebalance the agent may have done in response to it.
    out.push({ r: Math.log(b.mid / a.mid), dtDays, lpValueY: Math.max(0, a.lpValueY) });
  }
  return out;
}

/**
 * Realised volatility of the pool mid, expressed per day.
 * sigma_daily = sqrt( sum(r^2) / sum(dt_days) ) — time-weighted so it survives the
 * irregular sampling of ad-hoc runs rather than assuming a fixed cadence.
 * Returns null when there aren't enough usable intervals to say anything.
 */
export function realizedVolDaily(points: MidPoint[]): number | null {
  const iv = intervals(points);
  if (iv.length === 0) return null;
  const sumR2 = iv.reduce((s, x) => s + x.r * x.r, 0);
  const sumDt = iv.reduce((s, x) => s + x.dtDays, 0);
  if (!(sumDt > 0)) return null;
  return Math.sqrt(sumR2 / sumDt);
}

/**
 * The CPMM closed form: instantaneous LVR as a fraction of pool value is sigma^2/8 per
 * unit time. Returned in basis points per day.
 */
export function lvrRateBpsPerDay(sigmaDaily: number): number {
  return ((sigmaDaily * sigmaDaily) / 8) * 10_000;
}

/**
 * Modelled LVR over the sampled window, in y units: sum of (r^2 / 8) * lpValue.
 * Zero while not providing liquidity — LVR is a cost of being IN the pool, not of
 * holding inventory.
 */
export function cumulativeLvrY(points: MidPoint[]): number {
  return intervals(points).reduce((s, x) => s + ((x.r * x.r) / 8) * x.lpValueY, 0);
}

/**
 * The break-even question: how much daily volume must the POOL do for fee income to
 * cover LVR?
 *
 *   fees/day = poolShare * volume * feeRate
 *   LVR/day  = (sigma^2 / 8) * poolShare * poolValue
 *
 * Setting them equal, poolShare cancels — so this is a property of the POOL, identical
 * for every LP in it regardless of size:
 *
 *   volume = (sigma^2 / 8) * poolValue / feeRate
 *
 * Compare the result against the pool's actual volume. Below it, LPing loses money to
 * arbitrageurs faster than fees replace it, however the position is managed.
 */
export function breakEvenDailyVolume(sigmaDaily: number, poolValueY: number, feeBps: number): number {
  if (!(feeBps > 0) || !(poolValueY > 0)) return 0;
  return (((sigmaDaily * sigmaDaily) / 8) * poolValueY) / (feeBps / 10_000);
}

/** Roll the above into one estimate for logging/telemetry. */
export function estimateLvr(points: MidPoint[]): LvrEstimate {
  const iv = intervals(points);
  const windowDays = iv.reduce((s, x) => s + x.dtDays, 0);
  const sigmaDaily = realizedVolDaily(points);
  return {
    samples: iv.length,
    windowDays,
    sigmaDaily,
    lvrRateBpsPerDay: sigmaDaily === null ? null : lvrRateBpsPerDay(sigmaDaily),
    cumulativeLvrY: cumulativeLvrY(points),
  };
}
