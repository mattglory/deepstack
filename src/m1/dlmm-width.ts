// The DLMM range-width decision, as pure functions over recorded telemetry.
//
// Model (stated so it can be challenged): with a small share of the liquidity near the price
// (about 1.3% on 2026-10-28), both the fees we earn and the impermanent loss we take scale with
// how concentrated the position is, i.e. with 1 / (number of bins). So narrowing from h0 to h
// multiplies fees AND impermanent loss by (2·h0+1)/(2·h+1): it only helps if fees already beat
// impermanent loss at today's width. What narrowing adds for sure is recenters, each costing about
// half the position swapped at the pool fee, plus gas; how often is replayed from the real bin path.

export interface BinPoint { t: number; bin: number } // t in days

/** Volatility in bins per day from changes sampled at least `stepDays` apart. */
export function binVolAtHorizon(points: BinPoint[], stepDays: number): number | null {
  let sum = 0, n = 0, last = points[0];
  for (const p of points.slice(1)) {
    const dt = p.t - last.t;
    if (dt >= stepDays * 0.999) { sum += (p.bin - last.bin) ** 2 / dt; n++; last = p; }
  }
  return n >= 3 ? Math.sqrt(sum / n) : null;
}

/** Recenters a ±halfWidth position would have needed on this path, checked at each sample. */
export function backtestRecenters(points: BinPoint[], halfWidth: number): number {
  if (points.length === 0) return 0;
  let centre = points[0].bin, n = 0;
  for (const p of points) if (p.bin < centre - halfWidth || p.bin > centre + halfWidth) { n++; centre = p.bin; }
  return n;
}

/** Half the position swapped at the pool's total swap fee, plus gas for the transactions. */
export function recenterCostUsd(positionUsd: number, swapFeeBps = 50, gasUsd = 0.5): number {
  return (positionUsd / 2) * (swapFeeBps / 10_000) + gasUsd;
}

export interface WidthRow { halfWidth: number; recenters: number; feesPerDay: number; ilPerDay: number; recenterPerDay: number; netPerDay: number }

export function widthTable(a: {
  feesPerDay: number; ilPerDay: number; currentHalfWidth: number; spanDays: number; costUsd: number;
  recenters: Map<number, number>;
}): WidthRow[] {
  return [...a.recenters.keys()].sort((x, y) => x - y).map((h) => {
    const k = (2 * a.currentHalfWidth + 1) / (2 * h + 1);
    const recenterPerDay = (a.recenters.get(h)! / a.spanDays) * a.costUsd;
    const feesPerDay = a.feesPerDay * k, ilPerDay = a.ilPerDay * k;
    return { halfWidth: h, recenters: a.recenters.get(h)!, feesPerDay, ilPerDay, recenterPerDay, netPerDay: feesPerDay - ilPerDay - recenterPerDay };
  });
}

/**
 * The width to use, chosen cautiously:
 * - never narrower while fees do not beat impermanent loss at today's width (narrowing would only
 *   multiply the loss);
 * - never a width that would have recentered more than `maxRecentersPerDay` on the recorded path:
 *   each recenter is several transactions and locks in the loss of a price that left the range,
 *   which this model does not price;
 * - with fewer than `minDataDays` of measured fees, at most one cautious step: no narrower than
 *   `thinDataStep` of today's width (2026-11-04: eight days in which price returned to its start
 *   made impermanent loss read near zero, and the uncapped choice was ±10);
 * - only a change worth at least `minGainFrac` more net than today's width, so noise does not
 *   move the range.
 */
export function recommendWidth(
  rows: WidthRow[], currentHalfWidth: number,
  opts: { minGainFrac?: number; maxRecentersPerDay?: number; spanDays?: number; dataDays?: number; minDataDays?: number; thinDataStep?: number } = {},
): { halfWidth: number; reason: string } {
  const minGain = opts.minGainFrac ?? 0.2, maxRpd = opts.maxRecentersPerDay ?? 0.5, minDays = opts.minDataDays ?? 14, step = opts.thinDataStep ?? 0.7;
  const cur = rows.find((r) => r.halfWidth === currentHalfWidth);
  if (!cur) return { halfWidth: currentHalfWidth, reason: "current width not in the table" };
  if (cur.feesPerDay - cur.ilPerDay <= 0) return { halfWidth: currentHalfWidth, reason: "fees do not beat impermanent loss at today's width; narrowing would multiply the loss" };
  const thin = opts.dataDays != null && opts.dataDays < minDays;
  const allowed = rows.filter((r) =>
    (opts.spanDays == null || r.recenters / opts.spanDays <= maxRpd) &&
    (!thin || r.halfWidth >= Math.floor(currentHalfWidth * step)));
  const best = allowed.reduce((b, r) => (r.netPerDay > b.netPerDay ? r : b), cur);
  const caveat = thin ? ` (provisional: ${opts.dataDays!.toFixed(1)} days of fee data, under ${minDays}, so at most one step)` : "";
  if (best.halfWidth === currentHalfWidth || best.netPerDay < cur.netPerDay * (1 + minGain)) {
    return { halfWidth: currentHalfWidth, reason: `no allowed width beats today's by a clear margin${caveat}` };
  }
  return { halfWidth: best.halfWidth, reason: `about ${(best.netPerDay - cur.netPerDay).toFixed(2)}/day more net than ±${currentHalfWidth} on this data${caveat}` };
}
