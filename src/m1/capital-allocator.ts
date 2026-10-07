// V1 capital allocator — decides how much of DeepStack's total managed capital should be
// deployed as liquidity, and how that LP budget should split across venues (XYK sBTC/STX,
// DLMM sBTC/USDCx, and any future venue).
//
// Built per reports/STX sBTC DLMM pool and allocation.md's "buildable V1" design: a hard
// reserve floor + per-venue caps + trailing-ORGANIC-APR ranking inside those caps — NOT a
// continuous optimization formula. No real production system runs that at this capital scale;
// Yearn V3's own numerical optimizer is explicitly built for "hundreds of vaults," not a few
// thousand dollars (see the research report's own framing of that layer as overkill here).
// Real production allocators (Yearn V3's Debt Allocation Optimizer, Gauntlet's risk tiering)
// use hard caps as WALLS, then rank only within what's left — that's the pattern this mirrors.
//
// Incentive-subsidized yield is tracked as a SEPARATE signal (incentiveEligible), never
// blended into the ranking APR — the research's "mercenary capital" caution: a venue's
// trailing-organic-APR rank is earned on fees alone; incentive eligibility may only widen that
// venue's hard cap, never inflate its rank.
//
// Semi-automated by design, per the research's threshold-based-bounded-autonomy finding: this
// module only RECOMMENDS. Nothing here moves funds, calls a contract, or writes an env var.
// A recommended change larger than maxChangeFraction is flagged requiresApproval=true —
// mirrors the project's existing DLMM_LIVE/FLASH_LIVE pattern of a human-set gate the code
// never grants itself more of on its own.

export interface VenueState {
  key: string;
  currentValueY: number; // capital currently deployed at this venue, in Y (STX) terms
  trailingOrganicAprPct: number | null; // fees-only, IL-netted, annualised; null = no track record yet
  incentiveEligible: boolean; // a currently-live, named incentive program covers this venue
  maxCapFraction: number; // hard ceiling on this venue's share of TOTAL portfolio — a wall, not a weight
}

export interface AllocatorParams {
  reserveFloorFraction: number; // minimum fraction of total portfolio that must stay UNDEPLOYED
  maxChangeFraction: number; // max |change| (fraction of total portfolio) before requiresApproval
  incentiveCapBonusFraction: number; // extra cap headroom granted to an incentive-eligible venue
}

export interface VenueRecommendation {
  key: string;
  currentFraction: number;
  recommendedFraction: number;
  recommendedValueY: number;
  changeFraction: number; // signed: recommendedFraction - currentFraction
  requiresApproval: boolean;
  effectiveCapFraction: number;
  reason: string;
}

export interface AllocatorDecision {
  totalPortfolioY: number;
  totalLpBudgetFraction: number; // 1 - reserveFloorFraction
  venues: VenueRecommendation[];
}

export function defaultAllocatorParams(): AllocatorParams {
  return {
    // Every benchmark the research found (Basel III, US MMF rules, Yearn's own idle-fund
    // buffers, the Ethereum Foundation's treasury policy) sits at 25-50%+ reserve. 0.5 is the
    // conservative end of that range on purpose — DeepStack's own prior posture (65-70%
    // reserve) already exceeded every benchmark found, and this is the ceiling the allocator
    // will ever autonomously recommend moving toward, not a target to immediately reach.
    reserveFloorFraction: Number(process.env.ALLOC_RESERVE_FLOOR ?? 0.5),
    maxChangeFraction: Number(process.env.ALLOC_MAX_CHANGE ?? 0.1),
    incentiveCapBonusFraction: Number(process.env.ALLOC_INCENTIVE_CAP_BONUS ?? 0.05),
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Decide a recommended capital split across venues. Pure, deterministic, no I/O.
 *
 * Algorithm (hard filters first, then rank within what's left — not one weighted formula):
 *   1. The total LP budget is (1 - reserveFloorFraction) of total portfolio — a hard wall,
 *      never exceeded regardless of how attractive any venue's yield looks.
 *   2. Each venue has its own hard cap (maxCapFraction of TOTAL portfolio, widened by
 *      incentiveCapBonusFraction if currently incentive-eligible) — a venue never gets more
 *      than this no matter how it ranks.
 *   3. Within those two walls, the LP budget splits across venues in proportion to trailing
 *      ORGANIC APR (never incentive-inflated). A venue with no measured APR yet is never
 *      preferred over one with a real track record — see the cold-start and no-data branches
 *      below for exactly how it's NOT penalized to zero either.
 *   4. A change larger than maxChangeFraction from a venue's CURRENT allocation is flagged
 *      requiresApproval rather than silently recommended at full size — bounds how far a
 *      single recommendation can ask to move in one step, regardless of how far the
 *      ranked-ideal split sits from today.
 *
 * Known V1 simplification, deliberate: caps are applied independently per venue with no
 * leftover-budget redistribution (a venue capped below its ranked share doesn't free that
 * budget for another venue to exceed its own rank-implied share). A future version could add
 * water-filling; V1 keeps the simpler, easier-to-audit behavior on purpose.
 */
export function decideAllocation(venues: VenueState[], totalPortfolioY: number, p: AllocatorParams): AllocatorDecision {
  const lpBudgetFraction = clamp(1 - p.reserveFloorFraction, 0, 1);
  const lpBudgetY = lpBudgetFraction * totalPortfolioY;

  const caps = venues.map((v) => {
    const effectiveCapFraction = Math.min(1, v.maxCapFraction + (v.incentiveEligible ? p.incentiveCapBonusFraction : 0));
    return { v, effectiveCapFraction, capY: effectiveCapFraction * totalPortfolioY };
  });

  // "Measured, flat or losing" (apr !== null but <= 0) is a DIFFERENT state from "no data
  // yet" (apr === null) and must not collapse into it — a venue currently earning nothing or
  // losing to IL is real information, not an absence of information. Caught live, 2026-10-07:
  // the first version used (aprPct ?? 0) > 0 everywhere, which silently treated a measured
  // slightly-negative organic APR exactly like "no track record," hiding a real result behind
  // the cold-start message. Only genuinely POSITIVE measured APR ranks for proportional
  // weight; zero/negative measured APR holds its venue at current size, same action as the
  // no-data case takes for an unmeasured venue, but reported honestly as what it is.
  const hasAnyMeasurement = caps.some((c) => c.v.trailingOrganicAprPct !== null);
  const ranked = caps.filter((c) => (c.v.trailingOrganicAprPct ?? -Infinity) > 0);
  const totalApr = ranked.reduce((s, c) => s + (c.v.trailingOrganicAprPct as number), 0);

  const venueResults: VenueRecommendation[] = caps.map(({ v, effectiveCapFraction, capY }) => {
    const currentFraction = totalPortfolioY > 0 ? v.currentValueY / totalPortfolioY : 0;
    let targetY: number;
    let reason: string;

    if (totalApr > 0 && (v.trailingOrganicAprPct ?? -Infinity) > 0) {
      const weight = (v.trailingOrganicAprPct as number) / totalApr;
      targetY = Math.min(capY, lpBudgetY * weight);
      reason = `ranked by trailing organic APR (${(v.trailingOrganicAprPct as number).toFixed(1)}%), capped at ${(effectiveCapFraction * 100).toFixed(0)}% of portfolio`;
    } else if (v.trailingOrganicAprPct !== null) {
      // Measured, but flat or negative right now — hold at current size rather than grow
      // further into a venue that isn't currently earning; not the same message as "no data."
      targetY = Math.min(capY, v.currentValueY);
      reason = `measured organic APR is flat or negative (${v.trailingOrganicAprPct.toFixed(1)}%) — held at current size, not grown further`;
    } else if (!hasAnyMeasurement) {
      // No venue anywhere has a measured APR yet — split the LP budget evenly within caps
      // rather than sitting at zero forever waiting for a track record that needs capital
      // deployed to ever start accruing.
      targetY = Math.min(capY, lpBudgetY / caps.length);
      reason = "no venue has a measured trailing APR yet — even split within caps until one does";
    } else {
      // Other venues DO have a measured result (positive or not) but this one has none yet —
      // hold it at its current size rather than growing or shrinking it on no signal.
      targetY = Math.min(capY, v.currentValueY);
      reason = "no trailing APR measured yet for this venue — held at current size, not grown blind";
    }

    const recommendedFraction = totalPortfolioY > 0 ? targetY / totalPortfolioY : 0;
    const changeFraction = recommendedFraction - currentFraction;
    const requiresApproval = Math.abs(changeFraction) > p.maxChangeFraction;

    return {
      key: v.key,
      currentFraction,
      recommendedFraction,
      recommendedValueY: targetY,
      changeFraction,
      requiresApproval,
      effectiveCapFraction,
      reason: requiresApproval
        ? `${reason}; change of ${(changeFraction * 100).toFixed(1)}pp exceeds the ${(p.maxChangeFraction * 100).toFixed(0)}pp auto threshold — needs explicit approval`
        : reason,
    };
  });

  return { totalPortfolioY, totalLpBudgetFraction: lpBudgetFraction, venues: venueResults };
}
