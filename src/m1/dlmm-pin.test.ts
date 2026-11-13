// C4 / DSA-10 (assessment A4 F-02): the DLMM pool's token principals, core address, asset names
// and decimals used to come only from RPC. They become trait arguments, post-condition targets
// and the decimals behind USD sizing, so a wrong value from a compromised/misconfigured RPC must
// stop the cycle before anything is built or broadcast. Each pool now pins the expected values
// (verified on mainnet 2026-11-03) and recenterOnce skips when the RPC disagrees.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Cl, cvToHex, type ClarityValue } from "@stacks/transactions";
import { DLMM_POOLS, pinMismatch } from "./dlmm-read.js";
import { recenterOnce } from "./dlmm-recenter-exec.js";
import type { Wallet } from "./wallet.js";

const pool = (key: string) => DLMM_POOLS.find((p) => p.key === key)!;
const STX = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const CORE = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
const EVIL = "SP000000000000000000002Q6VF78.evil-usdcx";

test("every DLMM pool has a complete pin", () => {
  for (const p of DLMM_POOLS) {
    assert.ok(p.pin, `${p.key} has no pin`);
    assert.match(p.pin.xToken, /^S[PM][0-9A-Z]+\.[a-z0-9-]+$/);
    assert.match(p.pin.yToken, /^S[PM][0-9A-Z]+\.[a-z0-9-]+$/);
    assert.equal(p.pin.coreAddress, CORE);
    assert.ok(Number.isInteger(p.pin.xDecimals) && Number.isInteger(p.pin.yDecimals));
  }
});

test("pinMismatch: the live mainnet values for sbtc-usdcx match", () => {
  const st = { xToken: SBTC, yToken: USDCX, coreAddress: CORE };
  const x = { principal: SBTC, asset: "sbtc-token", decimals: 8 };
  const y = { principal: USDCX, asset: "usdcx-token", decimals: 6 };
  assert.equal(pinMismatch(pool("sbtc-usdcx"), st, x, y), null);
  assert.equal(pinMismatch(pool("sbtc-usdcx"), st), null); // state-only check
});

test("pinMismatch: a substituted token principal, core, asset or decimals is reported", () => {
  const p = pool("sbtc-usdcx");
  const st = { xToken: SBTC, yToken: USDCX, coreAddress: CORE };
  const x = { principal: SBTC, asset: "sbtc-token", decimals: 8 };
  const y = { principal: USDCX, asset: "usdcx-token", decimals: 6 };
  assert.match(pinMismatch(p, { ...st, yToken: EVIL })!, /y-token/);
  assert.match(pinMismatch(p, { ...st, xToken: STX })!, /x-token/);
  assert.match(pinMismatch(p, { ...st, coreAddress: "SP000000000000000000002Q6VF78.core" })!, /core/);
  assert.match(pinMismatch(p, st, { ...x, decimals: 6 }, y)!, /x decimals/);
  assert.match(pinMismatch(p, st, x, { ...y, decimals: 8 })!, /y decimals/);
  assert.match(pinMismatch(p, st, x, { ...y, asset: "usdcx" })!, /y asset/);
  assert.match(pinMismatch(p, st, x, { ...y, principal: EVIL })!, /y-token/);
});

// --- recenterOnce end to end, with fetch mocked (no network, nothing signed) --------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockChain(o: { yToken: string; yDecimals: number }) {
  const urls: string[] = [];
  const ok = (cv: ClarityValue) => new Response(JSON.stringify({ okay: true, result: cvToHex(cv) }), { status: 200 });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url.endsWith("/get-pool-for-swap")) {
      return ok(Cl.ok(Cl.tuple({
        "active-bin-id": Cl.int(100), "bin-step": Cl.uint(10), "core-address": Cl.principal(CORE),
        "initial-price": Cl.uint(100_000_000), "x-token": Cl.principal(STX), "y-token": Cl.principal(o.yToken),
      })));
    }
    if (url.includes("/v2/contracts/interface/")) {
      return new Response(JSON.stringify({ fungible_tokens: [{ name: "usdcx-token" }] }), { status: 200 });
    }
    if (url.endsWith("/get-decimals")) return ok(Cl.ok(Cl.uint(o.yDecimals)));
    if (url.endsWith("/get-user-bins")) return ok(Cl.ok(Cl.list([])));
    return new Response("not mocked", { status: 404 });
  }) as typeof fetch;
  return urls;
}

const W = { address: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR", key: "unused", network: "mainnet" } as Wallet;
const CFG = { pair: "stx-usdcx", halfWidth: 3, targetUsd: 40 };

test("recenterOnce: RPC-substituted y-token -> skipped + alert, no position read, no broadcast", async () => {
  const urls = mockChain({ yToken: EVIL, yDecimals: 6 });
  const r = await recenterOnce(W, CFG, true);
  assert.equal(r.executed, false);
  assert.equal(r.skipped, true);
  assert.equal(r.alert, true);
  assert.match(r.reason, /pinned/);
  assert.ok(!urls.some((u) => u.endsWith("/get-user-bins")), "must stop before reading/sizing a position");
  assert.ok(!urls.some((u) => u.includes("/v2/transactions")), "must not broadcast");
});

test("recenterOnce: RPC-reported decimals differ from the pin -> skipped, no broadcast", async () => {
  const urls = mockChain({ yToken: USDCX, yDecimals: 8 });
  const r = await recenterOnce(W, CFG, true);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /pinned/);
  assert.ok(!urls.some((u) => u.includes("/v2/transactions")));
});

test("recenterOnce: matching values pass the pin check (control)", async () => {
  const urls = mockChain({ yToken: USDCX, yDecimals: 6 });
  const r = await recenterOnce(W, CFG, false); // observe: decide only
  assert.doesNotMatch(r.reason, /pinned/);
  assert.ok(urls.some((u) => u.endsWith("/get-user-bins")), "proceeds to the position read");
  assert.ok(!urls.some((u) => u.includes("/v2/transactions")));
});
