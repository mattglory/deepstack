// Unit tests for RPC failover — the other uptime-critical path.
//
// The property under test: with fallbacks configured, one dead provider degrades to a
// warning, not a dead cycle — and the agent doesn't hammer the dead one forever.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { withRpc, endpoints } from "./rpc.js";

const PRIMARY = "https://api.mainnet.hiro.so";

beforeEach(() => {
  delete process.env.STACKS_API_FALLBACKS;
});

test("endpoints: primary only when no fallbacks configured", () => {
  assert.deepEqual(endpoints(), [PRIMARY]);
});

test("endpoints: fallbacks parsed, trimmed, trailing slashes stripped", () => {
  process.env.STACKS_API_FALLBACKS = " https://a.example/ ,, https://b.example ";
  assert.deepEqual(endpoints(), [PRIMARY, "https://a.example", "https://b.example"]);
});

test("withRpc: no fallbacks behaves exactly like a direct call — including the failure", async () => {
  assert.equal(await withRpc(async (b) => `ok via ${b}`), `ok via ${PRIMARY}`);
  await assert.rejects(
    withRpc(async () => {
      throw new Error("ECONNREFUSED");
    }),
    /ECONNREFUSED/,
  );
});

test("withRpc: a dead primary fails over, then STAYS on the working endpoint", async () => {
  process.env.STACKS_API_FALLBACKS = "https://backup.example";
  const hits: string[] = [];
  const flaky = async (b: string) => {
    hits.push(b);
    if (b === PRIMARY) throw new Error("primary down");
    return "ok";
  };
  assert.equal(await withRpc(flaky), "ok"); // primary fails → backup answers
  assert.equal(await withRpc(flaky), "ok"); // sticky: goes straight to backup
  assert.deepEqual(hits, [PRIMARY, "https://backup.example", "https://backup.example"]);
});

test("withRpc: only throws when EVERY endpoint fails — and surfaces the last error", async () => {
  process.env.STACKS_API_FALLBACKS = "https://backup.example";
  let n = 0;
  await assert.rejects(
    withRpc(async () => {
      throw new Error(`down ${++n}`);
    }),
    /down 2/,
  );
  // A later recovery is picked up — the failover never wedges itself.
  assert.equal(await withRpc(async () => "recovered"), "recovered");
});
