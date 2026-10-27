// Unit tests for the cycle supervisor — the uptime-critical path.
//
// The pilot's 95% uptime requirement rests on one property: a throwing cycle must not
// take the process down. These tests hold that property with a stub that throws on demand,
// because the real failure (a third-party API blinking) can't be summoned to order.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupervisor, type FailureReport } from "./supervise.js";

const boom = (msg = "fetch failed") => async () => {
  throw new Error(msg);
};
const fine = async () => {};

test("supervisor: a throwing cycle does not propagate — the agent survives", async () => {
  const s = createSupervisor();
  const ok = await s.run(boom()); // must not reject
  assert.equal(ok, false);
});

test("supervisor: a successful cycle reports success and keeps the counter at zero", async () => {
  const s = createSupervisor();
  assert.equal(await s.run(fine), true);
  assert.equal(s.consecutiveFailures(), 0);
});

test("supervisor: consecutive failures accumulate", async () => {
  const s = createSupervisor();
  await s.run(boom());
  await s.run(boom());
  await s.run(boom());
  assert.equal(s.consecutiveFailures(), 3);
});

test("supervisor: one success resets the streak — transient blips don't look like outages", async () => {
  const s = createSupervisor();
  await s.run(boom());
  await s.run(boom());
  assert.equal(s.consecutiveFailures(), 2);
  await s.run(fine);
  assert.equal(s.consecutiveFailures(), 0);
});

test("supervisor: failure reports carry the message and the streak count", async () => {
  const seen: FailureReport[] = [];
  const s = createSupervisor((r) => {
    seen.push(r);
  });
  await s.run(boom("rpc down"));
  await s.run(boom("rpc still down"));
  assert.deepEqual(
    seen.map((r) => [r.error, r.consecutive]),
    [
      ["rpc down", 1],
      ["rpc still down", 2],
    ],
  );
});

test("supervisor: a broken reporter cannot kill the agent", async () => {
  // If journalling or the healthcheck ping is itself down, the agent must keep running —
  // otherwise the alerting outage becomes the outage.
  const s = createSupervisor(() => {
    throw new Error("healthcheck unreachable");
  });
  assert.equal(await s.run(boom()), false); // must not reject
  assert.equal(s.consecutiveFailures(), 1);
});

test("supervisor: awaits an async reporter before moving on", async () => {
  let finished = false;
  const s = createSupervisor(async () => {
    await new Promise((r) => setTimeout(r, 5));
    finished = true;
  });
  await s.run(boom());
  assert.equal(finished, true, "reporter should be awaited, not fire-and-forget");
});

test("supervisor: survives a non-Error throw", async () => {
  const seen: FailureReport[] = [];
  const s = createSupervisor((r) => {
    seen.push(r);
  });
  await s.run(async () => {
    throw "just a string"; // eslint-disable-line no-throw-literal
  });
  assert.equal(seen[0].error, "just a string");
});

// --- briefError (2026-10-27) ---
import { briefError } from "./supervise.js";

test("briefError: an HTML gateway page becomes one line with its title", () => {
  const page = 'Error calling read-only function. Response 504: Gateway Time-out. <!DOCTYPE html>\n<html><head><title>api.mainnet.hiro.so | 504: Gateway time-out</title></head>\n<body>\n  <div>lots\n of markup</div></body></html>';
  const b = briefError(page);
  assert.equal(b, "Error calling read-only function. Response 504: Gateway Time-out. [HTML error page: api.mainnet.hiro.so | 504: Gateway time-out]");
  assert.ok(!b.includes("<"));
});

test("briefError: plain messages pass through, long ones are capped", () => {
  assert.equal(briefError("fetch failed"), "fetch failed");
  assert.equal(briefError("a\n  b"), "a b");
  const long = briefError("x".repeat(1000), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith("…"));
});
