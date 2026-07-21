// Tests for haven rotation — the stablecoin capital-preservation reflex.
//
// The decisive properties: haven target scales with regime; a route is only "ready" when a
// real USDCx pool has enough liquidity (dust ≠ ready); and the intent is honest about being
// armed-but-dormant when no route exists — never claims it can act when it can't.

import { test } from "node:test";
import assert from "node:assert/strict";
import { havenTargetFraction, havenRouteReady, decideHaven, defaultHavenParams, type HavenParams } from "./haven.js";

const P = (over: Partial<HavenParams> = {}): HavenParams => ({
  havenAsset: "USDCx",
  defensiveHavenFraction: 0.4,
  elevatedHavenFraction: 0.15,
  minRouteLiquidityUsd: 250_000,
  ...over,
});

test("haven target scales with regime", () => {
  assert.equal(havenTargetFraction("calm", P()), 0);
  assert.equal(havenTargetFraction("elevated", P()), 0.15);
  assert.equal(havenTargetFraction("defensive", P()), 0.4);
});

test("route readiness: dust pools are NOT ready (would slip catastrophically)", () => {
  const dust = [
    { pool: "sbtc-token/usdcx", liqUsd: 146_000 },
    { pool: "usdh/usdcx", liqUsd: 97_000 },
  ];
  const r = havenRouteReady(dust, P());
  assert.equal(r.ready, false);
  assert.equal(r.route, null);
  assert.match(r.reason, /dormant/);
});

test("route readiness: a deep enough USDCx pool flips it to ready", () => {
  const pools = [
    { pool: "sbtc-token/usdcx", liqUsd: 146_000 },
    { pool: "stx/usdcx", liqUsd: 600_000 }, // the pool that would launch it
  ];
  const r = havenRouteReady(pools, P());
  assert.equal(r.ready, true);
  assert.equal(r.route, "stx/usdcx");
});

test("route readiness: no USDCx pool at all → dormant, honest reason", () => {
  const r = havenRouteReady([{ pool: "sbtc-token/stx", liqUsd: 5_000_000 }], P());
  assert.equal(r.ready, false);
  assert.match(r.reason, /no USDCx pool/i);
});

test("decideHaven: defensive + no route → armed but honest it can't act", () => {
  const d = decideHaven("defensive", [{ pool: "x/usdcx", liqUsd: 100_000 }], P());
  assert.equal(d.targetHavenFraction, 0.4);
  assert.equal(d.ready, false);
  assert.match(d.status, /armed: want 40% USDCx/);
});

test("decideHaven: defensive + real route → states what it WOULD do", () => {
  const d = decideHaven("defensive", [{ pool: "stx/usdcx", liqUsd: 800_000 }], P());
  assert.equal(d.ready, true);
  assert.match(d.status, /WOULD rotate 40% → USDCx/);
});

test("decideHaven: calm → no haven needed regardless of routes", () => {
  const d = decideHaven("calm", [{ pool: "stx/usdcx", liqUsd: 800_000 }], P());
  assert.equal(d.targetHavenFraction, 0);
  assert.match(d.status, /no haven needed/);
});

test("defaults: USDCx haven, $250k min liquidity", () => {
  const p = defaultHavenParams();
  assert.equal(p.havenAsset, "USDCx");
  assert.equal(p.minRouteLiquidityUsd, 250_000);
});
