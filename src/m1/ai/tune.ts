// AI strategy layer (OpenRouter) — OFF the hot path.
//
// On a cadence, it classifies the market regime and proposes parameters for the
// deterministic core. Two hard safety rules:
//   1. Every AI-suggested value is CLAMPED to a safe range.
//   2. The hard caps (max swap sizes) are NEVER taken from the AI — they stay
//      whatever the base params say.
//   3. One-directional (C6 / DSA-12): the AI may only make the agent more cautious.
//      slippageBps is the min-out tolerance on live swaps (lower = tighter), so it is
//      min(base, ai). rebalanceBandBps is the drift tolerated before a rebalance swap
//      (wider = fewer swaps), so it is max(base, ai). Non-finite output keeps the base.
// Any error / missing key → fall back to the base params. The LLM never places
// a trade; it only nudges parameters the deterministic core already validates.

import { loadDotenv } from "../wallet.js";
import type { AgentParams } from "../agent.js";

export interface MarketState {
  midXinY: number;
  yFraction: number; // value share held in the quote (y) asset
  drift: number;
  totalY: number; // total free-inventory value in y
}

export interface TunedParams extends AgentParams {
  regime: string;
  rationale: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
// The model's value as a finite number, or the base when it is missing, non-numeric, NaN or ±Infinity.
const finiteOr = (v: unknown, fallback: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
// Bounds the whole OpenRouter call: a hung response used to stall the tick until the dead-man's switch.
const OPENROUTER_TIMEOUT_MS = 20_000;

function extractJson(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    return JSON.parse(m[0]);
  } catch {
    return {};
  }
}

export async function tuneParams(
  market: MarketState,
  base: AgentParams,
): Promise<TunedParams> {
  loadDotenv();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return { ...base, regime: "n/a", rationale: "AI tuning disabled (no OPENROUTER_API_KEY)" };
  }
  const model = process.env.OPENROUTER_MODEL ?? "~anthropic/claude-sonnet-latest";

  try {
    const prompt = [
      "You tune a market-making agent on a Stacks constant-product AMM (x/y pair).",
      "The agent holds a target value split between the two assets and rebalances via",
      "swaps when it drifts past a band. Given the state, classify the regime and",
      "suggest parameters. Wider band in choppy/volatile markets (less churn);",
      "tighter band + lower slippage in calm markets.",
      "",
      `State: mid=${market.midXinY.toFixed(4)} (y per x); quote(y) value share=${(market.yFraction * 100).toFixed(1)}%; drift from 50/50=${(market.drift * 100).toFixed(1)}%; inventory≈${market.totalY.toFixed(2)} (y).`,
      `Current params: targetYFraction=${base.targetYFraction}, rebalanceBandBps=${base.rebalanceBandBps}, slippageBps=${base.slippageBps}.`,
      "",
      'Respond with ONLY JSON: {"regime":"...","rationale":"one short sentence","targetYFraction":0.5,"rebalanceBandBps":500,"slippageBps":100}',
    ].join("\n");

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Title": "DeepStack",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const p = extractJson(j.choices?.[0]?.message?.content ?? "");

    return {
      ...base, // keeps the hard caps (maxSwap*) — AI cannot change these
      // targetYFraction has no "safer" direction; agent-cli's applyAllocation overwrites it.
      targetYFraction: clamp(finiteOr(p.targetYFraction, base.targetYFraction), 0.3, 0.7),
      rebalanceBandBps: Math.round(
        Math.max(base.rebalanceBandBps, clamp(finiteOr(p.rebalanceBandBps, base.rebalanceBandBps), 100, 2000)),
      ),
      slippageBps: Math.round(Math.min(base.slippageBps, clamp(finiteOr(p.slippageBps, base.slippageBps), 10, 300))),
      regime: String(p.regime ?? "?"),
      rationale: String(p.rationale ?? ""),
    };
  } catch (err) {
    return {
      ...base,
      regime: "error",
      rationale: `AI tuning failed, using safe defaults: ${(err as Error).message}`,
    };
  }
}
