// Unit tests for the V1 capital allocator — the load-bearing properties: (1) the reserve
// floor is never exceeded regardless of how attractive a venue's yield looks; (2) per-venue
// caps are hard walls, not soft weights; (3) incentive eligibility only ever widens a cap,
// never inflates a rank; (4) a large recommended change is flagged for approval, never
// silently proposed at full size; (5) a venue with no track record is neither preferred nor
// zeroed out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAllocation, defaultAllocatorParams, type AllocatorParams, type VenueState } from "./capital-allocator.js";

const P = (over: Partial<AllocatorParams> = {}): AllocatorParams => ({
  reserveFloorFraction: 0.5,
  maxChangeFraction: 0.1,
  incentiveCapBonusFraction: 0.05,
  ...over,
});

const V = (over: Partial<VenueState> = {}): VenueState => ({
  key: "venue",
  currentValueY: 0,
  trailingOrganicAprPct: null,
  incentiveEligible: false,
  maxCapFraction: 1,
  ...over,
});

test("allocator: the reserve floor is a hard wall — total recommended LP never exceeds 1 - reserveFloorFraction", () => {
  const venues = [V({ key: "a", trailingOrganicAprPct: 500, maxCapFraction: 1 }), V({ key: "b", trailingOrganicAprPct: 500, maxCapFraction: 1 })];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5 }));
  const totalLpY = d.venues.reduce((s, v) => s + v.recommendedValueY, 0);
  assert.ok(totalLpY <= 500 + 1e-9);
  assert.equal(d.totalLpBudgetFraction, 0.5);
});

test("allocator: equal trailing APR across two uncapped venues → the LP budget splits evenly", () => {
  const venues = [V({ key: "a", trailingOrganicAprPct: 10, maxCapFraction: 1 }), V({ key: "b", trailingOrganicAprPct: 10, maxCapFraction: 1 })];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5 }));
  assert.equal(d.venues[0].recommendedValueY, 250);
  assert.equal(d.venues[1].recommendedValueY, 250);
});

test("allocator: a higher trailing organic APR gets proportionally more of the LP budget", () => {
  const venues = [V({ key: "hi", trailingOrganicAprPct: 300 }), V({ key: "lo", trailingOrganicAprPct: 100 })];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5, maxChangeFraction: 1 }));
  // budget 500, weights 300/400 and 100/400
  assert.equal(d.venues[0].recommendedValueY, 375);
  assert.equal(d.venues[1].recommendedValueY, 125);
});

test("allocator: a per-venue cap is a hard wall — never exceeded even when it would win the full ranked share", () => {
  const venues = [V({ key: "capped", trailingOrganicAprPct: 1000, maxCapFraction: 0.1 }), V({ key: "other", trailingOrganicAprPct: 10, maxCapFraction: 1 })];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5, maxChangeFraction: 1 }));
  assert.ok(d.venues[0].recommendedValueY <= 100 + 1e-9); // 10% of 1000, not its much larger ranked share
});

test("allocator: incentive eligibility widens a venue's cap, but never inflates its rank weight", () => {
  const venues = [
    V({ key: "incentivized", trailingOrganicAprPct: 50, maxCapFraction: 0.2, incentiveEligible: true }),
    V({ key: "plain", trailingOrganicAprPct: 50, maxCapFraction: 1, incentiveEligible: false }),
  ];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5, maxChangeFraction: 1, incentiveCapBonusFraction: 0.1 }));
  assert.ok(Math.abs(d.venues[0].effectiveCapFraction - 0.3) < 1e-9); // 0.2 + 0.1 bonus (float-safe compare)
  // Equal APR → equal rank weight (250 each from the 500 budget) regardless of the cap bonus.
  assert.equal(d.venues[0].recommendedValueY, 250);
  assert.equal(d.venues[1].recommendedValueY, 250);
});

test("allocator: a recommended change beyond maxChangeFraction is flagged requiresApproval, not silently proposed at full size", () => {
  const venues = [V({ key: "a", currentValueY: 0, trailingOrganicAprPct: 100, maxCapFraction: 1 })];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5, maxChangeFraction: 0.1 }));
  // recommended fraction would be 0.5 (the whole budget, only one venue) vs current 0 → change 0.5 > 0.1
  assert.equal(d.venues[0].requiresApproval, true);
  assert.ok(d.venues[0].recommendedValueY > 0); // still computed and reported, just flagged
});

test("allocator: a recommended change within maxChangeFraction does not require approval", () => {
  const venues = [V({ key: "a", currentValueY: 480, trailingOrganicAprPct: 100, maxCapFraction: 1 })];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5, maxChangeFraction: 0.1 }));
  // recommended 500 (whole budget), current 480 → change 0.02, within 0.1
  assert.equal(d.venues[0].requiresApproval, false);
});

test("allocator: a measured flat/negative APR is NOT treated as no-data — held at current size with an honest reason, distinct from the cold-start case (regression test: caught live 2026-10-07 reading real XYK telemetry with a slightly negative organic return)", () => {
  const venues = [V({ key: "losing", currentValueY: 100, trailingOrganicAprPct: -2.25, maxCapFraction: 1 }), V({ key: "winning", currentValueY: 100, trailingOrganicAprPct: 50, maxCapFraction: 1 })];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5, maxChangeFraction: 1 }));
  assert.equal(d.venues[0].recommendedValueY, 100); // held, not grown
  assert.match(d.venues[0].reason, /flat or negative/);
  assert.doesNotMatch(d.venues[0].reason, /no venue has a measured|no trailing APR measured/);
  // the winning venue still ranks and gets the full LP budget, since -2.25 contributes 0 weight
  assert.equal(d.venues[1].recommendedValueY, 500);
});

test("allocator: no venue anywhere has a measured APR yet → even split within caps, not stuck at zero", () => {
  const venues = [V({ key: "a", maxCapFraction: 1 }), V({ key: "b", maxCapFraction: 1 })];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5, maxChangeFraction: 1 }));
  assert.equal(d.venues[0].recommendedValueY, 250);
  assert.equal(d.venues[1].recommendedValueY, 250);
});

test("allocator: a venue with no track record alongside others that DO have one is held at current size, not zeroed or grown blind", () => {
  const venues = [V({ key: "proven", currentValueY: 200, trailingOrganicAprPct: 100, maxCapFraction: 1 }), V({ key: "unproven", currentValueY: 50, trailingOrganicAprPct: null, maxCapFraction: 1 })];
  const d = decideAllocation(venues, 1000, P({ reserveFloorFraction: 0.5, maxChangeFraction: 1 }));
  assert.equal(d.venues[1].recommendedValueY, 50); // held, not zeroed, not grown
  assert.match(d.venues[1].reason, /held at current size/);
});

test("allocator: totalPortfolioY of 0 never divides by zero — all fractions are 0", () => {
  const venues = [V({ key: "a", trailingOrganicAprPct: 100 })];
  const d = decideAllocation(venues, 0, P());
  assert.equal(d.venues[0].currentFraction, 0);
  assert.equal(d.venues[0].recommendedFraction, 0);
});

test("defaultAllocatorParams: reads env vars, falls back to the conservative defaults", () => {
  const p = defaultAllocatorParams();
  assert.equal(p.reserveFloorFraction, 0.5);
  assert.equal(p.maxChangeFraction, 0.1);
  assert.equal(p.incentiveCapBonusFraction, 0.05);
});
