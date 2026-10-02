// Dashboard P&L / IL-adjusted-return math — extracted from index.html's inline script so
// it's importable by a Node test without a DOM or a browser (external review, issue #7 —
// "the dashboard's P&L / IL-adjusted-return math ... untested"). Pure: no fetch, no DOM,
// only arithmetic on the metrics/sample objects passed in. index.html imports this file as
// an ES module — one source of truth, not a copy kept in sync by hand between the page and
// its tests.

// Value, in Y (STX) terms, of HOLDING the pilot's fixed-inception baseline basket, priced at
// the given sample's mid/stxUsd. Returns null when a required piece isn't available for THIS
// sample — a sample's own stxUsd (needed to value the USDCx-denominated legs) only exists
// from when that tracking started, so earlier samples correctly fall out of any series built
// from this rather than being charted against an incomplete, silently-wrong comparison.
export function hodlNow(m, s) {
  const b = m.pilotBaseline;
  if (!b || !(s.mid > 0)) return null;
  // FIXED snapshots taken once at pilot start (b.lpBasis/b.dlmmBasis) — NOT the top-level
  // m.lpBasis/m.dlmmBasis, which are meant to evolve with real capital events (an
  // add/withdraw, or a DLMM position going empty and later reopening). Using the mutable
  // ones here is exactly the 2026-09-22 bug: fixing the DLMM P&L card's basis (correctly, on
  // a real reopen) silently moved this pilot-wide "hold your original basket" comparison too.
  // Falls back to the mutable fields only for metrics files from before this snapshot existed.
  const lpBasis = b.lpBasis ?? m.lpBasis;
  const dlmmBasis = b.dlmmBasis ?? m.dlmmBasis;
  const usdcxQty = (b.usdcxQty ?? 0) + (dlmmBasis?.yQty ?? 0);
  if (usdcxQty > 0 && !(s.stxUsd > 0)) return null;
  let v = (Number(b.xBase) / 1e8) * s.mid + Number(b.yBase) / 1e6;
  if (lpBasis) v += lpBasis.xQty * s.mid + lpBasis.yQty;
  if (dlmmBasis) v += dlmmBasis.xQty * s.mid;
  if (usdcxQty > 0) v += usdcxQty / s.stxUsd;
  return v;
}

// IL-adjusted return: current portfolio vs hodlNow() at the same sample, as a percentage.
// null when hodlNow can't be computed yet, or is non-positive (division guard) — the caller
// (the headline card) renders null as "n/a", never as 0 or a fabricated number.
export function ilAdjustedReturn(m, s) {
  const hodl = hodlNow(m, s);
  return hodl !== null && hodl > 0 ? ((s.portfolioY - hodl) / hodl) * 100 : null;
}

// Glitch filter for the performance chart's series: a failed LP/DLMM-value read shows up as
// an implausible portfolio spike/drop relative to the HODL baseline, not as a missing sample
// — drop points where the two diverge by more than this fraction of the HODL value, well
// beyond realistic IL for this pilot's actual price/vol range. hodl must also be a valid,
// positive value (see hodlNow) or the point can't be compared at all.
export function isPlausibleAgainstHodl(portfolioY, hodl, maxFrac = 0.2) {
  return hodl !== null && hodl > 0 && Math.abs(portfolioY - hodl) < maxFrac * hodl;
}
