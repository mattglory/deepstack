// C5 / DSA-11: the external reference (safety.ts getExternalMid) and the XYK min-out floor
// (quotes.ts floorMinOutByReference). Before: CoinGecko only, no staleness check, and min-outs
// taken from the RPC quote alone. fetch and the journal are faked: no network.

import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const journal: Record<string, unknown>[] = [];
mock.module("./journal.js", {
  namedExports: { appendJournal: (e: Record<string, unknown>) => void journal.push(e), pingHealthcheck: async () => {} },
});
const { getExternalMid, combineReferences, assertFresh, oracleParams } = await import("./safety.js");
const { floorMinOutByReference, minusSlippage } = await import("./quotes.js");

const realFetch = globalThis.fetch;
const ENV = ["EXTERNAL_PRICE_MAX_AGE_SECS", "EXTERNAL_PRICE_MAX_SOURCE_DIVERGENCE_BPS", "XYK_REF_MIN_OUT_BAND_BPS", "PAIR", "COINGECKO_API_KEY"];
beforeEach(() => {
  journal.length = 0;
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const now = () => Math.floor(Date.now() / 1000);
// sbtc-stx (the default PAIR): x = bitcoin, y = blockstack. BTC $100,000, STX $0.30.
interface Src { btc: number; stx: number; age?: number; down?: boolean }
function mockSources(cg: Src, ll: Src): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.startsWith("https://api.coingecko.com/")) {
      if (cg.down) return new Response("rate limited", { status: 403 });
      const t = now() - (cg.age ?? 60);
      return json({ bitcoin: { usd: cg.btc, last_updated_at: t }, blockstack: { usd: cg.stx, last_updated_at: t } });
    }
    if (url.startsWith("https://coins.llama.fi/")) {
      if (ll.down) throw new Error("fetch failed");
      const t = now() - (ll.age ?? 60);
      return json({ coins: { "coingecko:bitcoin": { price: ll.btc, timestamp: t }, "coingecko:blockstack": { price: ll.stx, timestamp: t } } });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return urls;
}

// ---- getExternalMid ---------------------------------------------------------------------------

test("both sources fresh and agreeing -> their mean; CoinGecko asked for last_updated_at", async () => {
  const urls = mockSources({ btc: 100_000, stx: 0.3 }, { btc: 100_400, stx: 0.3 });
  const m = await getExternalMid();
  assert.ok(m);
  assert.ok(Math.abs(m.midXinY - (100_000 / 0.3 + 100_400 / 0.3) / 2) < 1e-6);
  assert.match(urls.find((u) => new URL(u).hostname.endsWith("coingecko.com"))!, /include_last_updated_at=true/);
  assert.equal(urls.find((u) => u.includes("llama"))!, "https://coins.llama.fi/prices/current/coingecko:bitcoin,coingecko:blockstack");
  assert.equal(journal.length, 0);
});

test("stale CoinGecko price (20 min) -> no reference (fail closed), journalled", async () => {
  mockSources({ btc: 100_000, stx: 0.3, age: 20 * 60 }, { btc: 100_000, stx: 0.3 });
  assert.equal(await getExternalMid(), null);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].type, "oracle-reject");
  assert.match(String(journal[0].reason), /coingecko: stale \(\d+s old > 900s\)/);
});

test("stale DefiLlama price -> no reference", async () => {
  mockSources({ btc: 100_000, stx: 0.3 }, { btc: 100_000, stx: 0.3, age: 16 * 60 });
  assert.equal(await getExternalMid(), null);
  assert.match(String(journal[0].reason), /defillama: stale/);
});

test("sources disagree beyond 2% -> no reference (fail closed), journalled with both answers", async () => {
  mockSources({ btc: 100_000, stx: 0.3 }, { btc: 100_000, stx: 0.31 }); // STX 3.3% apart
  assert.equal(await getExternalMid(), null);
  assert.equal(journal.length, 1);
  assert.match(String(journal[0].reason), /reference sources disagree by \d+bps > 200bps/);
  assert.deepEqual((journal[0].defillama as { yUsd: number }).yUsd, 0.31);
});

test("one source down -> no reference (fail closed), either way round", async () => {
  mockSources({ btc: 100_000, stx: 0.3, down: true }, { btc: 100_000, stx: 0.3 });
  assert.equal(await getExternalMid(), null);
  assert.match(String(journal[0].reason), /coingecko unavailable: HTTP 403/);
  mockSources({ btc: 100_000, stx: 0.3 }, { btc: 100_000, stx: 0.3, down: true });
  assert.equal(await getExternalMid(), null);
  assert.match(String(journal[1].reason), /defillama unavailable: fetch failed/);
});

test("bounds are configurable by env; a malformed bound fails closed", async () => {
  process.env.EXTERNAL_PRICE_MAX_SOURCE_DIVERGENCE_BPS = "400";
  mockSources({ btc: 100_000, stx: 0.3 }, { btc: 100_000, stx: 0.31 });
  assert.ok(await getExternalMid(), "3.3% apart is inside a 4% bound");
  process.env.EXTERNAL_PRICE_MAX_AGE_SECS = "abc";
  assert.equal(await getExternalMid(), null);
  assert.match(String(journal.at(-1)!.reason), /EXTERNAL_PRICE_MAX_AGE_SECS must be a positive number/);
});

// ---- pure pieces --------------------------------------------------------------------------------

test("combineReferences / assertFresh: defaults, missing timestamp, zero price", () => {
  assert.deepEqual(oracleParams(), { maxAgeSecs: 900, maxSourceDivergenceBps: 200 });
  const t = 1_000_000;
  const ok = { xUsd: 100_000, yUsd: 0.3, t };
  assert.equal(combineReferences(ok, ok, t + 900).ok, true);
  assert.equal(combineReferences(ok, ok, t + 901).ok, false);
  assert.equal(combineReferences({ ...ok, t: NaN }, ok, t).ok, false);
  assert.equal(combineReferences({ ...ok, yUsd: 0 }, ok, t).ok, false);
  assert.equal(combineReferences("HTTP 500", ok, t).ok, false);
  assert.throws(() => assertFresh(0, "x", t), /no update timestamp/);
});

// ---- XYK min-out floor --------------------------------------------------------------------------

// Constant-product output with the fee taken on the input (the XYK pools' model).
const cpOut = (amountIn: number, rIn: number, rOut: number, feeBps: number) => {
  const inNet = amountIn * (1 - feeBps / 10_000);
  return (inNet * rOut) / (rIn + inNet);
};

test("floor: realistic fixtures — anywhere inside the 5% safety band the real fill clears the floor, and a normal pool keeps its quote-based min-out", () => {
  const REF = 100_000 / 0.3; // STX per sBTC
  const xDec = 8, yDec = 6, slip = 100;
  for (const feeBps of [30, 50]) {
    for (const devBps of [-500, -300, -100, 0, 100, 300, 500]) {
      const poolMid = REF * (1 + devBps / 10_000);
      // ~$1.5M of liquidity a side, roughly the live sBTC-STX pool; the agent's trade cap is 50 STX.
      const rx = 15, ry = 15 * poolMid;
      for (const stxIn of [50, 500, 5_000]) {
        // y-for-x (buy sBTC with STX)
        const yIn = BigInt(stxIn * 10 ** yDec);
        const dx = BigInt(Math.floor(cpOut(stxIn, ry, rx, feeBps) * 10 ** xDec));
        const qMin = minusSlippage(dx, slip);
        const m = floorMinOutByReference(qMin, "y-for-x", yIn, REF, xDec, yDec, slip);
        assert.ok(m >= qMin);
        assert.ok(dx >= m, `y-for-x fee ${feeBps} dev ${devBps} ${stxIn} STX: fill ${dx} < floor ${m}`);
        if (Math.abs(devBps) <= 300) assert.equal(m, qMin, `floor binds on a normal pool (dev ${devBps})`);
        // x-for-y (sell the sBTC equivalent)
        const sbtc = stxIn / REF;
        const xIn = BigInt(Math.floor(sbtc * 10 ** xDec));
        const dy = BigInt(Math.floor(cpOut(Number(xIn) / 10 ** xDec, rx, ry, feeBps) * 10 ** yDec));
        const qMin2 = minusSlippage(dy, slip);
        const m2 = floorMinOutByReference(qMin2, "x-for-y", xIn, REF, xDec, yDec, slip);
        assert.ok(dy >= m2, `x-for-y fee ${feeBps} dev ${devBps} ${stxIn} STX: fill ${dy} < floor ${m2}`);
        if (Math.abs(devBps) <= 300) assert.equal(m2, qMin2);
      }
    }
  }
});

test("floor: a deflated quote is raised to the reference floor; it only ever gets stricter", () => {
  const REF = 100_000;
  const yIn = 50_000_000n; // 50 STX -> 50,000 sats at the reference
  assert.equal(floorMinOutByReference(9_900n, "y-for-x", yIn, REF, 8, 6, 100), 47_000n);
  assert.equal(floorMinOutByReference(49_500n, "y-for-x", yIn, REF, 8, 6, 100), 49_500n);
  const xIn = 50_000n; // 0.0005 sBTC -> 50 STX
  assert.equal(floorMinOutByReference(1n, "x-for-y", xIn, REF, 8, 6, 100), 47_000_000n);
  process.env.XYK_REF_MIN_OUT_BAND_BPS = "200";
  assert.equal(floorMinOutByReference(1n, "x-for-y", xIn, REF, 8, 6, 100), 48_500_000n);
  process.env.XYK_REF_MIN_OUT_BAND_BPS = "-1";
  assert.throws(() => floorMinOutByReference(1n, "x-for-y", xIn, REF, 8, 6, 100), /XYK_REF_MIN_OUT_BAND_BPS/);
  delete process.env.XYK_REF_MIN_OUT_BAND_BPS;
  assert.throws(() => floorMinOutByReference(1n, "x-for-y", xIn, 0, 8, 6, 100), /no usable reference/);
});
