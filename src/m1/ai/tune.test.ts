// C6 / DSA-12 (assessment A4 F-04): the AI layer may only make the agent MORE cautious.
//   slippageBps: the min-out tolerance on live swaps (quotes.ts minusSlippage). Lower = tighter
//                min-out, so the model may only lower or keep the base: min(base, ai).
//   rebalanceBandBps: drift tolerated before a rebalance swap. Wider = fewer swaps (less churn
//                and fees), so the model may only widen or keep the base: max(base, ai).
// Non-finite model output falls back to the base, and the OpenRouter call is time-bounded.
// fetch is mocked: no network.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tuneParams } from "./tune.js";
import { defaultParams } from "../agent.js";

const realFetch = globalThis.fetch;
const savedKey = process.env.OPENROUTER_API_KEY;
let lastInit: RequestInit | undefined;
beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  lastInit = undefined;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
});

const MARKET = { midXinY: 400_000, yFraction: 0.5, drift: 0, totalY: 1000 };
function modelSays(content: string) {
  globalThis.fetch = (async (_u: Parameters<typeof fetch>[0], init?: RequestInit) => {
    lastInit = init;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
}

const base = defaultParams(); // slippage 100, band 500

test("slippage: the model cannot RAISE it above the base (was: up to 300bps)", async () => {
  modelSays('{"regime":"calm","slippageBps":300,"rebalanceBandBps":500}');
  const t = await tuneParams(MARKET, base);
  assert.equal(t.slippageBps, base.slippageBps);
});

test("slippage: the model may lower it (still floored at 10bps)", async () => {
  modelSays('{"regime":"calm","slippageBps":40}');
  assert.equal((await tuneParams(MARKET, base)).slippageBps, 40);
  modelSays('{"regime":"calm","slippageBps":1}');
  assert.equal((await tuneParams(MARKET, base)).slippageBps, 10);
});

test("band: the model cannot NARROW it below the base (was: down to 100bps)", async () => {
  modelSays('{"regime":"calm","rebalanceBandBps":100}');
  assert.equal((await tuneParams(MARKET, base)).rebalanceBandBps, base.rebalanceBandBps);
});

test("band: the model may widen it (still capped at 2000bps)", async () => {
  modelSays('{"regime":"choppy","rebalanceBandBps":900}');
  assert.equal((await tuneParams(MARKET, base)).rebalanceBandBps, 900);
  modelSays('{"regime":"choppy","rebalanceBandBps":99999}');
  assert.equal((await tuneParams(MARKET, base)).rebalanceBandBps, 2000);
});

test("non-finite / non-numeric outputs fall back to the base (was: NaN)", async () => {
  modelSays('{"regime":"?","slippageBps":"abc","rebalanceBandBps":"NaN","targetYFraction":"x"}');
  const t = await tuneParams(MARKET, base);
  assert.equal(t.slippageBps, base.slippageBps);
  assert.equal(t.rebalanceBandBps, base.rebalanceBandBps);
  assert.equal(t.targetYFraction, base.targetYFraction);
  modelSays('{"slippageBps":1e999,"rebalanceBandBps":null}');
  const u = await tuneParams(MARKET, base);
  assert.equal(u.slippageBps, base.slippageBps);
  assert.equal(u.rebalanceBandBps, base.rebalanceBandBps);
});

test("the OpenRouter request carries an abort signal (bounded, no hung tick)", async () => {
  modelSays('{"regime":"calm"}');
  await tuneParams(MARKET, base);
  assert.ok(lastInit?.signal instanceof AbortSignal);
});

test("a hung OpenRouter call falls back to the base params once the signal aborts", async () => {
  // The timeout is made to fire immediately instead of after 20 s. Without a signal (main), the
  // mock must not hang the runner, so it answers "HUNG" instead, which fails the assertion.
  globalThis.fetch = ((_u: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise((res, rej) => {
      const sig = init?.signal;
      if (!sig) {
        setTimeout(() => res(new Response(JSON.stringify({ choices: [{ message: { content: '{"regime":"HUNG"}' } }] }))), 50);
        return;
      }
      if (sig.aborted) return rej(sig.reason);
      sig.addEventListener("abort", () => rej(sig.reason));
    })) as typeof fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (() => AbortSignal.abort(new Error("timeout"))) as typeof AbortSignal.timeout;
  try {
    const t = await tuneParams(MARKET, base);
    assert.equal(t.regime, "error");
    assert.equal(t.slippageBps, base.slippageBps);
    assert.equal(t.rebalanceBandBps, base.rebalanceBandBps);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});
