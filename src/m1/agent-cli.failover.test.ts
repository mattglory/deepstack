// C2 / DSA-08: the agent's hot-path pool read and its broadcasts go through rpc.ts (configured
// endpoints, failover, per-attempt timeout that ABORTS the hung request) instead of the SDK's
// default endpoint with no timeout. Runs the harness in REAL-RPC mode: rpc.ts, pool.ts,
// stacks.ts and the SDK's broadcastTransaction are real; only the network (world.net) is fake.

import "./agent-cli.harness-real-rpc.js";
import { rec, world, resetHarness, runAgent, tickEntries, outOfBandWorld, LIVE } from "./agent-cli.harness.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Cl } from "@stacks/transactions";
// rpc.js only after the harness has registered its mocks: a static import here would be
// resolved at link time, binding rpc.ts to the unmocked @stacks/transactions.
const { withRpc } = await import("./rpc.js");

const PRIMARY = "https://rpc.invalid"; // STACKS_API in the harness
const FALLBACK = "https://fallback.invalid";

// rpc.ts sticks to the last endpoint that worked; start every test on the primary. With one
// endpoint configured, withRpc resets an out-of-range preference to 0.
async function startOnPrimary(fallbacks: string): Promise<void> {
  process.env.STACKS_API_FALLBACKS = "";
  await withRpc(async () => undefined);
  process.env.STACKS_API_FALLBACKS = fallbacks;
}

const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const WSTX = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
const readOk = (cv: Parameters<typeof Cl.serialize>[0]) =>
  new Response(JSON.stringify({ okay: true, result: `0x${Cl.serialize(cv)}` }), { status: 200 });

/** A healthy node: get-pool (mid 100,000 STX/sBTC), get-decimals, tx status, broadcast. */
function healthy(url: string, init?: RequestInit): Promise<Response> {
  if (url.includes("/xyk-pool-sbtc-stx-v-1-1/get-pool")) {
    return Promise.resolve(readOk(Cl.ok(Cl.tuple({
      "pool-symbol": Cl.stringAscii("sBTC-STX"),
      "x-token": Cl.principal(SBTC),
      "y-token": Cl.principal(WSTX),
      "x-balance": Cl.uint(5_000_000_000n), // 50 sBTC
      "y-balance": Cl.uint(5_000_000_000_000n), // 5,000,000 STX
      "x-provider-fee": Cl.uint(30),
      "x-protocol-fee": Cl.uint(0),
      "pool-status": Cl.bool(true),
    }))));
  }
  if (url.includes("/sbtc-token/get-decimals")) return Promise.resolve(readOk(Cl.ok(Cl.uint(8))));
  if (url.includes("/token-stx-v-1-2/get-decimals")) return Promise.resolve(readOk(Cl.ok(Cl.uint(6))));
  if (url.includes("/extended/v1/tx/")) return Promise.resolve(new Response(JSON.stringify({ tx_status: "success" }), { status: 200 }));
  if (url.endsWith("/v2/transactions")) {
    const hex = JSON.parse(String(init?.body)).tx as string;
    return Promise.resolve(new Response(JSON.stringify(`0x${txidOf(hex)}`), { status: 200 }));
  }
  return Promise.reject(new Error(`fake node: unexpected ${url}`));
}

// The txid the harness's signed tx has: recorded at the SDK broadcast call.
const txidOf = (_hex: string) => (rec.broadcasts[rec.broadcasts.length - 1] as { transaction: { txid(): string } }).transaction.txid();

/** A request that never answers until its signal aborts (then rejects, as fetch does). */
const hung = { started: 0, aborted: 0 };
function hang(init?: RequestInit): Promise<Response> {
  hung.started++;
  return new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => {
      hung.aborted++;
      rej(new DOMException("aborted", "AbortError"));
    });
  });
}

/** Routes by host; anything off the configured endpoints fails the request (and the test). */
function network(byHost: Record<string, (url: string, init?: RequestInit) => Promise<Response>>) {
  return (url: string, init?: RequestInit) => {
    const h = byHost[new URL(url).origin];
    return h ? h(url, init) : Promise.reject(new Error(`request to an unconfigured endpoint: ${url}`));
  };
}
const bodies = (origin: string) => rec.fetches.filter((u) => u === `${origin}/v2/transactions`).length;

beforeEach(() => {
  resetHarness();
  hung.started = hung.aborted = 0;
});

test("hot-path pool read: a hung primary is timed out, ABORTED, and the fallback answers", async () => {
  await startOnPrimary(FALLBACK);
  world.net = network({ [PRIMARY]: (_u, init) => hang(init), [FALLBACK]: healthy });
  const r = await runAgent([]); // observe, one-shot
  assert.equal(r.error, undefined, String(r.error));
  const [t] = tickEntries();
  assert.equal(t.mid, 100_000, "mid read from the fallback");
  assert.ok(rec.fetches.some((u) => u.startsWith(`${FALLBACK}/v2/contracts/call-read/`)), "pool read went to the fallback");
  assert.ok(hung.started >= 1, "the primary was tried first");
  assert.equal(hung.aborted, hung.started, "every hung request was aborted, not left open");
});

test("broadcast: hung primary → the SAME signed tx goes to the fallback; one signature, one txid", async () => {
  resetHarness(outOfBandWorld());
  await startOnPrimary(FALLBACK);
  world.net = network({
    [PRIMARY]: (u, init) => (u.endsWith("/v2/transactions") ? hang(init) : healthy(u, init)),
    [FALLBACK]: healthy,
  });
  const r = await runAgent(LIVE);
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(rec.contractCalls.length, 1, "signed exactly once (no re-sign, no new nonce)");
  assert.equal(bodies(PRIMARY), 1);
  assert.equal(bodies(FALLBACK), 1);
  assert.equal(rec.broadcasts.length, 2);
  const [a, b] = rec.broadcasts as { transaction: { serialize(): string } }[];
  assert.equal(a.transaction.serialize(), b.transaction.serialize(), "byte-identical rebroadcast");
  assert.equal(hung.aborted, 1, "the hung broadcast request was aborted");
  const txid = (rec.broadcasts[0] as { transaction: { txid(): string } }).transaction.txid();
  const t = tickEntries()[0];
  assert.equal(t.txid, `0x${txid}`);
  assert.equal(t.status, "success");
});

const rejected = (reason: string) => (u: string, init?: RequestInit) => {
  if (!u.endsWith("/v2/transactions")) return healthy(u, init);
  const tx = JSON.parse(String(init?.body)).tx as string;
  return Promise.resolve(new Response(JSON.stringify({ error: "transaction rejected", reason, txid: txidOf(tx) }), { status: 400 }));
};

test("broadcast: ConflictingNonceInMempool for OUR txid (already in the mempool) is success", async () => {
  resetHarness(outOfBandWorld());
  await startOnPrimary("");
  world.net = network({ [PRIMARY]: rejected("ConflictingNonceInMempool") }); // tx lookup → healthy: known
  await runAgent(LIVE);
  const txid = (rec.broadcasts[0] as { transaction: { txid(): string } }).transaction.txid();
  const t = tickEntries()[0];
  assert.equal(t.txid, `0x${txid}`);
  assert.equal(t.broadcastError, undefined);
});

test("broadcast: ConflictingNonceInMempool with our txid unknown, or any other rejection, is a failure (even though the node echoes a txid)", async () => {
  for (const reason of ["ConflictingNonceInMempool", "NotEnoughFunds"]) {
    resetHarness(outOfBandWorld());
    await startOnPrimary("");
    const node = rejected(reason);
    world.net = network({
      [PRIMARY]: (u, init) => (u.includes("/extended/v1/tx/") ? Promise.resolve(new Response("{}", { status: 404 })) : node(u, init)),
    });
    await runAgent(LIVE);
    const t = tickEntries()[0];
    assert.equal(t.txid, undefined, reason);
    assert.match(String(t.broadcastError), new RegExp(reason));
    assert.equal(rec.broadcasts.length, 1, `${reason}: a definite rejection is not retried`);
  }
});

test("broadcast: every endpoint down → a failed broadcast, never a re-signed retry", async () => {
  resetHarness(outOfBandWorld());
  await startOnPrimary(FALLBACK);
  const down = (u: string, init?: RequestInit) => (u.endsWith("/v2/transactions") ? Promise.reject(new Error("ECONNRESET")) : healthy(u, init));
  world.net = network({ [PRIMARY]: down, [FALLBACK]: down });
  await runAgent(LIVE);
  assert.equal(rec.contractCalls.length, 1);
  assert.equal(rec.broadcasts.length, 2, "tried each endpoint once with the same tx");
  const t = tickEntries()[0];
  assert.equal(t.txid, undefined);
  assert.match(String(t.broadcastError), /ECONNRESET/);
});

