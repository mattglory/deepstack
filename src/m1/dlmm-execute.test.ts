// Tests for the DLMM executor's gate — the single most safety-critical property in the write
// path: it must NEVER broadcast (never touch key or network) unless BOTH explicit gates are set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canBroadcast, executeDescriptor } from "./dlmm-execute.js";
import type { CallDescriptor } from "./dlmm-write.js";

const D: CallDescriptor = {
  contractAddress: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD",
  contractName: "dlmm-liquidity-router-v-1-2",
  functionName: "add-liquidity-multi",
  functionArgs: [],
  note: "test",
};

test("canBroadcast: requires BOTH gates", () => {
  assert.equal(canBroadcast({}), false);
  assert.equal(canBroadcast({ live: true }), false);
  assert.equal(canBroadcast({ yesMainnet: true }), false);
  assert.equal(canBroadcast({ live: true, yesMainnet: true }), true);
});

test("executeDescriptor: no gates → dry-run, no broadcast, no key needed", async () => {
  const r = await executeDescriptor(D); // note: no senderKey at all
  assert.equal(r.broadcast, false);
  assert.equal(r.dryRun, true);
  assert.match(r.summary, /DRY-RUN/);
});

test("executeDescriptor: one gate only → still a dry-run", async () => {
  const r1 = await executeDescriptor(D, { live: true });
  const r2 = await executeDescriptor(D, { yesMainnet: true });
  assert.equal(r1.dryRun, true);
  assert.equal(r2.dryRun, true);
});

test("executeDescriptor: both gates but no key → refuses (never broadcasts keyless)", async () => {
  await assert.rejects(() => executeDescriptor(D, { live: true, yesMainnet: true }), /no senderKey/);
});

test("executeDescriptor: both gates + key but NO input-cap post-conditions → refuses", async () => {
  // The unsafe path (a real write with no spend cap) must be refused, not broadcast.
  await assert.rejects(
    () => executeDescriptor(D, { live: true, yesMainnet: true, senderKey: "dead".repeat(16), postConditions: [] }),
    /no input-cap post-conditions/,
  );
});
