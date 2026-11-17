// C5 / DSA-11 through the live orchestrator: an XYK swap's min-out used to come only from the
// RPC quote, so a deflated quote lowered the guard with it. agent-cli now passes the external
// reference to the builders, which floor the min-out by it (quotes.ts floorMinOutByReference).
// Same harness as agent-cli.test.ts (B4): nothing reaches the network, the key is a throwaway.

import { rec, world, resetHarness, runAgent, outOfBandWorld, baseWorld, SWAP_CAP_Y, MID, LIVE } from "./agent-cli.harness.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Cl } from "@stacks/transactions";

beforeEach(() => resetHarness());

test("y-for-x: a deflated quote no longer lowers the min-out; it is floored by the reference", async () => {
  resetHarness({ ...outOfBandWorld(), swapYForXQuote: 10_000n }); // ~20% of the true 50,000 sats
  const r = await runAgent(LIVE);
  assert.equal(r.error, undefined);
  assert.equal(rec.builds[0].opts.refMidXinY, MID);
  const c = rec.contractCalls[0];
  assert.equal(c.functionName, "swap-y-for-x");
  assert.deepEqual(c.functionArgs[3], Cl.uint(SWAP_CAP_Y));
  // 50 STX at 100,000 STX/sBTC = 50,000 sats; floor = 50,000 x (1 - (500 band + 100 slippage) bps)
  assert.deepEqual(c.functionArgs[4], Cl.uint(47_000n));
});

test("x-for-y: a deflated quote is floored by the reference too", async () => {
  // Out of band toward x: 0.01 sBTC (1,000 STX) vs 100 STX (50 tradable) -> sell sBTC.
  resetHarness({ ...baseWorld(), xBase: 1_000_000n, yBase: 100_000_000n, nativeStxMicro: 100_000_000n, swapXForYQuote: 1_000_000n });
  const r = await runAgent(LIVE);
  assert.equal(r.error, undefined);
  const b = rec.builds[0];
  assert.equal(b.fn, "buildSwapXForY");
  const c = rec.contractCalls[0];
  assert.equal(c.functionName, "swap-x-for-y");
  const refOutMicroStx = (Number(b.amount) / 1e8) * MID * 1e6;
  assert.deepEqual(c.functionArgs[4], Cl.uint(BigInt(Math.floor(refOutMicroStx * 0.94))));
  assert.ok(Math.floor(refOutMicroStx * 0.94) > 990_000, "stricter than the deflated quote's own min-out");
});

test("a normal quote keeps its quote-based min-out (the floor does not bind)", async () => {
  resetHarness(outOfBandWorld()); // quote 49,000 sats for 50 STX: 2% under the reference
  await runAgent(LIVE);
  assert.deepEqual(rec.contractCalls[0].functionArgs[4], Cl.uint(48_510n));
  assert.equal(world.externalMid, MID);
});
