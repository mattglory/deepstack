// C8 / DSA-27: KILL used to be checked once per cycle, so an operator halt did not stop a DLMM
// recenter already in progress (withdraw -> up to 6 swaps -> re-add) or a flash arm -> loan.
// It is now re-checked immediately before each broadcast. These tests engage KILL part-way
// through a sequence (from inside the mocked network, after the cycle's first check passed) and
// assert that the next broadcast never happens and the pending re-add stays saved for a resume.
// fetch is mocked: no network access, nothing is signed or broadcast.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cl, cvToHex, type ClarityValue } from "@stacks/transactions";
import { recenterOnce } from "./dlmm-recenter-exec.js";
import { flashRebalanceOnce } from "../m2/flash-rebalance-exec.js";
import type { Wallet } from "./wallet.js";

const STX = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const CORE = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
const W = { address: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR", key: "unused", network: "mainnet" } as Wallet;

let dir: string;
let pendingPath: string;
const realFetch = globalThis.fetch;
const saved = { APP_DIR: process.env.APP_DIR, DLMM_PENDING_STATE_PATH: process.env.DLMM_PENDING_STATE_PATH, KILL_SWITCH: process.env.KILL_SWITCH };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deepstack-killseq-"));
  pendingPath = join(dir, "pending.json");
  process.env.APP_DIR = dir;
  process.env.DLMM_PENDING_STATE_PATH = pendingPath;
  delete process.env.KILL_SWITCH;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const engageKill = () => writeFileSync(join(dir, "KILL"), "");
const ok = (cv: ClarityValue) => new Response(JSON.stringify({ okay: true, result: cvToHex(cv) }), { status: 200 });
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

/** A mocked chain; `killOn` engages KILL when a URL containing it is first requested. */
function mockChain(killOn: string) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url.includes(killOn)) engageKill();
    if (url.endsWith("/get-pool-for-swap")) {
      return ok(Cl.ok(Cl.tuple({
        "active-bin-id": Cl.int(100), "bin-step": Cl.uint(10), "core-address": Cl.principal(CORE),
        "initial-price": Cl.uint(100_000_000), "x-token": Cl.principal(STX), "y-token": Cl.principal(USDCX),
      })));
    }
    if (url.includes("/v2/contracts/interface/")) return json({ fungible_tokens: [{ name: "usdcx-token" }] });
    if (url.endsWith("/get-decimals")) return ok(Cl.ok(Cl.uint(6)));
    if (url.endsWith("/get-user-bins")) return ok(Cl.ok(Cl.list([])));
    if (url.endsWith("/get-bin-balances")) return ok(Cl.ok(Cl.tuple({ "x-balance": Cl.uint(1e12), "y-balance": Cl.uint(1e12), "bin-shares": Cl.uint(1e12) })));
    if (url.endsWith("/get-bin-price")) return ok(Cl.ok(Cl.uint(30_000_000))); // 0.30 USDCx per STX
    if (url.includes("/nonces")) return json({ detected_missing_nonces: [], detected_mempool_nonces: [] });
    if (url.includes("coins.llama.fi")) return json({ coins: { "coingecko:blockstack": { price: 0.3 } } });
    // flash
    if (url.endsWith("/get-fee-basis-points")) return ok(Cl.ok(Cl.uint(5)));
    if (url.endsWith("/get-max-single-loan")) return ok(Cl.ok(Cl.uint(1e12)));
    if (url.endsWith("/get-reserve-balance")) return ok(Cl.uint(1e12));
    if (url.endsWith("/is-approved-receiver")) return ok(Cl.bool(true));
    if (url.endsWith("/balances")) return json({ stx: { balance: "1000000000" }, fungible_tokens: {} });
    return new Response("not mocked", { status: 404 });
  }) as typeof fetch;
  return urls;
}

const writePending = (xBase: bigint, yBase: bigint) =>
  writeFileSync(pendingPath, JSON.stringify({ pair: "stx-usdcx", xBase: xBase.toString(), yBase: yBase.toString(), before: { x: 1, y: 1 }, t: "2026-11-03T00:00:00Z", abortedSwaps: 0 }));
const CFG = { pair: "stx-usdcx", halfWidth: 3, targetUsd: 40 };
const broadcasts = (urls: string[]) => urls.filter((u) => u.includes("/v2/transactions"));

test("DLMM re-add: KILL engaged after the cycle's first check stops the next rebalance swap; pending stays saved", async () => {
  writePending(1_000_000_000n, 0n); // all STX: the next step is an x-for-y rebalance swap
  const before = readFileSync(pendingPath, "utf8");
  const urls = mockChain("coins.llama.fi"); // KILL appears while the swap is being planned
  const r = await recenterOnce(W, CFG, true);
  assert.equal(r.executed, false);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /kill switch/);
  assert.deepEqual(broadcasts(urls), []);
  assert.ok(existsSync(pendingPath), "pending re-add must stay saved for the resume");
  assert.equal(readFileSync(pendingPath, "utf8"), before);
});

test("DLMM re-add: KILL engaged before the final re-add stops it; pending stays saved", async () => {
  writePending(1_000_000_000n, 300_000_000n); // ~50/50 by value at 0.30: the next step is the add
  const urls = mockChain("coins.llama.fi");
  const r = await recenterOnce(W, CFG, true);
  assert.equal(r.executed, false);
  assert.match(r.reason, /kill switch/);
  assert.deepEqual(broadcasts(urls), []);
  assert.ok(existsSync(pendingPath));
});

test("flash: KILL engaged after the first check stops the arm broadcast", async () => {
  const urls = mockChain("/balances"); // KILL appears while sizing
  const r = await flashRebalanceOnce(W, { amountStxBase: 200_000_000n, directCapStxBase: 50_000_000n, maxAmountStxBase: 150_000_000n }, true);
  assert.equal(r.executed, false);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /kill switch/);
  assert.equal(r.armTxid, undefined);
  assert.deepEqual(broadcasts(urls), []);
});
