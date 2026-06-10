// The deterministic market-making core (seed).
//
// This is the part of the system that, in production, NEVER has an LLM in its
// hot path. The AI layer only feeds it parameters (spread, range) on a cadence.
// Given a mid price + parameters it produces a concrete two-sided quote and an
// LP range — exactly the decision the live bot would act on.

export interface QuoteParams {
  mid: number; // reference/mid price (target per base)
  spreadBps: number; // total bid/ask spread in basis points
  rangeBps: number; // LP range half-width in basis points
}

export interface Quote {
  mid: number;
  bid: number;
  ask: number;
  spreadBps: number;
  lpLower: number;
  lpUpper: number;
  rangeBps: number;
}

const bps = (x: number, n: number) => (x * n) / 10_000;

export function computeQuote({ mid, spreadBps, rangeBps }: QuoteParams): Quote {
  const halfSpread = bps(mid, spreadBps / 2);
  const halfRange = bps(mid, rangeBps);
  return {
    mid,
    bid: round(mid - halfSpread),
    ask: round(mid + halfSpread),
    spreadBps,
    lpLower: round(mid - halfRange),
    lpUpper: round(mid + halfRange),
    rangeBps,
  };
}

function round(x: number): number {
  return Math.round(x * 1e8) / 1e8; // 8 dp, sat-friendly
}
