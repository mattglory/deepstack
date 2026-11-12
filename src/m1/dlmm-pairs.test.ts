// Unit tests for the extra-DLMM-pair configuration (dlmm-pairs.ts): which pairs, where each keeps
// its state, and which settings it reads. The primary pair's files and settings must be unchanged.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  POSITION_PAIRS, primaryDlmmPair, extraDlmmPairs, isPrimaryPair, isExtraPair, pairScopedPath,
  pairSettingName, pairSetting, extraPairsLive,
} from "./dlmm-pairs.js";
import { DLMM_POOLS } from "./dlmm-read.js";
import { stxPerUnit, freeBalanceCounted } from "./dlmm-extra-value.js";
import { sizeTwoSidedDeposit } from "./dlmm-recenter.js";

const KEYS = ["DLMM_OBSERVE_PAIR", "DLMM_EXTRA_PAIRS", "DLMM_LIVE", "DLMM_EXTRA_LIVE", "DLMM_TARGET_USD", "DLMM_TARGET_USD__STX_SBTC"];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

test("every position pair is a pinned DLMM pool", () => {
  for (const k of POSITION_PAIRS) assert.ok(DLMM_POOLS.some((p) => p.key === k), k);
  assert.ok(!POSITION_PAIRS.includes("stx-usdcx-v1"), "a conversion route is not a position pair");
});

test("extra pairs: parsed, de-duplicated; unknown, repeated-primary or primary-less configs refuse", () => {
  process.env.DLMM_OBSERVE_PAIR = "sbtc-usdcx";
  assert.deepEqual(extraDlmmPairs(), []);
  process.env.DLMM_EXTRA_PAIRS = " stx-sbtc , stx-sbtc,";
  assert.deepEqual(extraDlmmPairs(), ["stx-sbtc"]);
  process.env.DLMM_EXTRA_PAIRS = "stx-sbtc,nope";
  assert.throws(() => extraDlmmPairs(), /'nope' is not a known/);
  process.env.DLMM_EXTRA_PAIRS = "stx-usdcx-v1";
  assert.throws(() => extraDlmmPairs(), /not a known DLMM position pair/);
  process.env.DLMM_EXTRA_PAIRS = "sbtc-usdcx";
  assert.throws(() => extraDlmmPairs(), /already the primary/);
  delete process.env.DLMM_OBSERVE_PAIR;
  process.env.DLMM_EXTRA_PAIRS = "stx-sbtc";
  assert.throws(() => extraDlmmPairs(), /needs a primary/);
});

test("state paths: the primary's are unchanged; an extra pair's get .<pair> before the extension", () => {
  const p = "journal/dlmm-pending-readd.json";
  assert.equal(pairScopedPath(p, "stx-sbtc"), p, "no primary configured: legacy behaviour");
  process.env.DLMM_OBSERVE_PAIR = "sbtc-usdcx";
  process.env.DLMM_EXTRA_PAIRS = "stx-sbtc";
  assert.equal(primaryDlmmPair(), "sbtc-usdcx");
  assert.equal(pairScopedPath(p, null), p);
  assert.equal(pairScopedPath(p, "sbtc-usdcx"), p);
  assert.equal(pairScopedPath(p, "stx-sbtc"), "journal/dlmm-pending-readd.stx-sbtc.json");
  assert.equal(pairScopedPath("/opt/x.y/state", "stx-sbtc"), "/opt/x.y/state.stx-sbtc", "a dot in a directory is not an extension");
  assert.throws(() => pairScopedPath(p, "../evil"), /bad pair key/);
  assert.equal(isPrimaryPair("sbtc-usdcx"), true);
  assert.equal(isExtraPair("stx-sbtc"), true);
  assert.equal(isExtraPair("sbtc-usdcx"), false);
});

test("settings: the primary reads the plain name, an extra pair only its own, never a fallback", () => {
  process.env.DLMM_OBSERVE_PAIR = "sbtc-usdcx";
  process.env.DLMM_TARGET_USD = "4000";
  assert.equal(pairSettingName("DLMM_TARGET_USD", "stx-sbtc"), "DLMM_TARGET_USD__STX_SBTC");
  assert.equal(pairSetting("DLMM_TARGET_USD", "sbtc-usdcx"), "4000");
  assert.equal(pairSetting("DLMM_TARGET_USD", "stx-sbtc"), undefined, "the primary's target is never borrowed");
  process.env.DLMM_TARGET_USD__STX_SBTC = "800";
  assert.equal(pairSetting("DLMM_TARGET_USD", "stx-sbtc"), "800");
});

test("extra pairs broadcast only with both DLMM_LIVE=1 and DLMM_EXTRA_LIVE=1", () => {
  assert.equal(extraPairsLive(), false);
  process.env.DLMM_LIVE = "1";
  assert.equal(extraPairsLive(), false);
  process.env.DLMM_EXTRA_LIVE = "1";
  assert.equal(extraPairsLive(), true);
  delete process.env.DLMM_LIVE;
  assert.equal(extraPairsLive(), false);
});

test("stxPerUnit: STX 1, sBTC at the XYK mid, a stablecoin at 1/STX price; unknown -> null", () => {
  const stx = { native: true, principal: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2", asset: "" };
  const sbtc = { native: false, principal: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", asset: "sbtc-token" };
  const usdcx = { native: false, principal: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx", asset: "usdcx-token" };
  assert.equal(stxPerUnit(stx, 240_000, 0.3), 1);
  assert.equal(stxPerUnit(sbtc, 240_000, 0.3), 240_000);
  assert.ok(Math.abs(stxPerUnit(usdcx, 240_000, 0.25)! - 4) < 1e-12);
  assert.equal(stxPerUnit(usdcx, 240_000, 0), null);
  assert.equal(stxPerUnit({ native: false, principal: "SP1.other", asset: "x" }, 240_000, 0.3), null);
  // Free balances already counted elsewhere are never counted twice.
  assert.equal(freeBalanceCounted(stx, []), true);
  assert.equal(freeBalanceCounted(sbtc, []), true);
  assert.equal(freeBalanceCounted(usdcx, [`${usdcx.principal}::${usdcx.asset}`]), true);
  assert.equal(freeBalanceCounted(usdcx, []), false);
});

test("sizeTwoSidedDeposit: a non-dollar Y (sBTC) is sized by its price, not as $1", () => {
  // stx-sbtc: X = STX at $0.30 (6 dp), Y = sBTC at $72,000 (8 dp), target $1,000.
  const s = sizeTwoSidedDeposit(1000, 0.3, 10_000_000_000n, 100_000_000n, 6, 8, 72_000);
  assert.equal(s.xBase, 1_666_666_666n); // $500 of STX
  assert.equal(s.yBase, 694_444n); // $500 of sBTC, not 500 sBTC
  assert.ok(Math.abs(s.valueUsd - 1000) < 0.01);
  // A USDCx pool is unchanged (yPriceUsd defaults to 1).
  assert.deepEqual(sizeTwoSidedDeposit(200, 0.14, 10_000_000_000n, 10_000_000_000n), sizeTwoSidedDeposit(200, 0.14, 10_000_000_000n, 10_000_000_000n, 6, 6, 1));
});
