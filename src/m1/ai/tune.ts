// AI strategy layer (OpenRouter) — OFF the hot path.
//
// On a cadence, it classifies the market regime and proposes parameters for the
// deterministic core. Two hard safety rules:
//   1. Every AI-suggested value is CLAMPED to a safe range.
//   2. The hard caps (max swap sizes) are NEVER taken from the AI — they stay
//      whatever the base params say.
// Any error / missing key → fall back to the base params. The LLM never places
// a trade; it only nudges parameters the deterministic core already validates.

import { loadDotenv } from "../wallet.js";
import type { AgentParams } from "../agent.js";

export interface MarketState {
  midXinY: number;
  stxFraction: number;
  drift: number;
  totalStx: number;
}

export interface TunedParams extends AgentParams {
  regime: string;
  rationale: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

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
      "You tune a market-making agent on a Stacks sBTC/STX constant-product AMM.",
      "The agent holds a target value split between STX and sBTC and rebalances via",
      "swaps when it drifts past a band. Given the state, classify the regime and",
      "suggest parameters. Wider band in choppy/volatile markets (less churn);",
      "tighter band + lower slippage in calm markets.",
      "",
      `State: mid=${market.midXinY.toFixed(0)} STX/sBTC; STX value share=${(market.stxFraction * 100).toFixed(1)}%; drift from 50/50=${(market.drift * 100).toFixed(1)}%; inventory≈${market.totalStx.toFixed(0)} STX.`,
      `Current params: targetStxFraction=${base.targetStxFraction}, rebalanceBandBps=${base.rebalanceBandBps}, slippageBps=${base.slippageBps}.`,
      "",
      'Respond with ONLY JSON: {"regime":"...","rationale":"one short sentence","targetStxFraction":0.5,"rebalanceBandBps":500,"slippageBps":100}',
    ].join("\n");

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Title": "DeepStack",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const p = extractJson(j.choices?.[0]?.message?.content ?? "");

    return {
      ...base, // keeps the hard caps (maxSwap*) — AI cannot change these
      targetStxFraction: clamp(Number(p.targetStxFraction ?? base.targetStxFraction), 0.3, 0.7),
      rebalanceBandBps: Math.round(
        clamp(Number(p.rebalanceBandBps ?? base.rebalanceBandBps), 100, 2000),
      ),
      slippageBps: Math.round(clamp(Number(p.slippageBps ?? base.slippageBps), 10, 300)),
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
