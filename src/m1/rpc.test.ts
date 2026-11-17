// Unit tests for RPC failover — the other uptime-critical path.
//
// The property under test: with fallbacks configured, one dead provider degrades to a
// warning, not a dead cycle — and the agent doesn't hammer the dead one forever.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { withRpc, endpoints, hiroHeaders, redactEndpoint } from "./rpc.js";

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

// A stuck (not erroring) endpoint previously hung withRpc forever — no fallback ever
// triggered because the loop just sat on a promise that never settled. These pin down
// the fix: a hanging attempt is raced against a timeout and treated as a failure like
// any other, so the loop still moves on.
test("withRpc: a hanging endpoint is treated as a failure — times out and fails over", async () => {
  process.env.STACKS_API_FALLBACKS = "https://backup.example";
  const hits: string[] = [];
  let first: string | null = null;
  // Whichever endpoint withRpc tries first (sticky state from earlier tests makes that
  // not always PRIMARY) hangs forever; the other answers immediately.
  const hangy = async (b: string) => {
    hits.push(b);
    if (first === null) first = b;
    if (b === first) return new Promise(() => {}); // never resolves
    return "ok";
  };
  assert.equal(await withRpc(hangy, 20), "ok");
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0], hits[1]);
});

test("withRpc: no fallback + a hanging endpoint rejects with a timeout, not forever", async () => {
  await assert.rejects(
    withRpc(() => new Promise(() => {}), 20),
    /timed out after 20ms/,
  );
});

// C8 / DSA-25 (assessment A4 F-09): endpoint URLs can carry a provider token in the path or
// query (QuickNode style); they must never reach logs/journal. The Hiro API key must only go to
// a real hiro.so host, and plain-http endpoints are refused.
const SECRET_FALLBACK = "https://x.quiknode.pro/SECRET-TOKEN/?key=SECRET2";

test("redactEndpoint: keeps scheme+host, drops path and query", () => {
  assert.equal(redactEndpoint(SECRET_FALLBACK), "https://x.quiknode.pro/…");
  assert.equal(redactEndpoint("https://api.mainnet.hiro.so"), "https://api.mainnet.hiro.so");
  assert.equal(redactEndpoint("not a url SECRET"), "<invalid endpoint>");
});

test("withRpc: a timeout error does not contain the endpoint's path/query", async () => {
  process.env.STACKS_API_FALLBACKS = SECRET_FALLBACK;
  await assert.rejects(withRpc(() => new Promise(() => {}), 10), (e: Error) => {
    assert.match(e.message, /timed out/);
    assert.doesNotMatch(e.message, /SECRET/);
    return true;
  });
});

test("withRpc: the failover warning does not contain the endpoint's path/query", async () => {
  process.env.STACKS_API_FALLBACKS = SECRET_FALLBACK;
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    // Whichever endpoint is tried first fails; the other answers -> one "switched" warning.
    let first: string | null = null;
    await withRpc(async (b) => {
      if (first === null) first = b;
      if (b === first) throw new Error("down");
      return "ok";
    });
  } finally {
    console.warn = orig;
  }
  assert.ok(warned.some((w) => /switched/.test(w)));
  assert.ok(warned.every((w) => !/SECRET/.test(w)), warned.join("\n"));
});

test("hiroHeaders: key attached only to a real hiro.so hostname", () => {
  const saved = process.env.HIRO_API_KEY;
  process.env.HIRO_API_KEY = "k";
  try {
    assert.deepEqual(hiroHeaders("https://api.mainnet.hiro.so"), { "x-api-key": "k" });
    assert.deepEqual(hiroHeaders("https://api.hiro.so"), { "x-api-key": "k" });
    assert.deepEqual(hiroHeaders("https://api.hiro.so.attacker.tld"), {});
    assert.deepEqual(hiroHeaders("https://attacker.tld/api.hiro.so"), {});
    assert.deepEqual(hiroHeaders("https://attacker.tld/?h=x.hiro.so"), {});
    assert.deepEqual(hiroHeaders("https://evilhiro.so"), {});
    assert.deepEqual(hiroHeaders("http://api.mainnet.hiro.so"), {}); // never over plain http
  } finally {
    if (saved === undefined) delete process.env.HIRO_API_KEY;
    else process.env.HIRO_API_KEY = saved;
  }
});

test("endpoints: a non-https endpoint is refused", () => {
  process.env.STACKS_API_FALLBACKS = "http://plain.example";
  assert.throws(() => endpoints(), /https/);
  process.env.STACKS_API_FALLBACKS = "ftp://x.example";
  assert.throws(() => endpoints(), /https/);
});

test("withRpc: an endpoint's own error that echoes its URL is scrubbed before it propagates", async () => {
  process.env.STACKS_API_FALLBACKS = SECRET_FALLBACK;
  // Pin the sticky endpoint to the primary so the secret endpoint is tried LAST (its error is the one surfaced).
  await withRpc(async (b) => { if (b !== PRIMARY) throw new Error("x"); return 1; });
  await assert.rejects(withRpc(async (b) => { throw new Error(`Attempted to fetch ${b}/v2/accounts/SP1 and failed`); }), (e: Error) => {
    assert.match(e.message, /Attempted to fetch/);
    assert.doesNotMatch(e.message, /SECRET/);
    return true;
  });
});
