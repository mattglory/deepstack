// DeepStack agent — the deterministic decision core.
//
// On a full-range XYK pool there is no concentrated range to manage, so the v1
// agent keeps a target sBTC/STX inventory split and rebalances via swaps when it
// drifts outside a band. This is the "decide" step; it is a PURE function (no
// I/O), so it is reproducible and the AI layer only feeds it parameters.

export interface AgentParams {
  targetStxFraction: number; // target value share held in STX (0..1)
  rebalanceBandBps: number; // drift tolerance before acting (bps)
  maxSwapStxUstx: bigint; // cap on a single STX->sBTC swap (microSTX)
  maxSwapSbtcBase: bigint; // cap on a single sBTC->STX swap (base, 8dp)
  slippageBps: number; // slippage guard passed to the action builders
}

export interface Inventory {
  sbtcBase: bigint; // 8 dp
  stxMicro: bigint; // 6 dp
}

export interface Decision {
  action: "none" | "swap-y-for-x" | "swap-x-for-y";
  amountBase: bigint; // STX (uSTX) for swap-y-for-x; sBTC (base) for swap-x-for-y
  reason: string;
  metrics: {
    sbtcValueStx: number;
    stxValueStx: number;
    totalStx: number;
    stxFraction: number;
    drift: number;
  };
}

// AI strategy layer plugs in here (OpenRouter, on a cadence). Static for now —
// deterministic and reproducible until the tuning layer is wired.
export function defaultParams(): AgentParams {
  return {
    targetStxFraction: 0.5,
    rebalanceBandBps: 500, // 5%
    maxSwapStxUstx: 10_000_000n, // 10 STX
    maxSwapSbtcBase: 30_000n, // 0.0003 sBTC
    slippageBps: 100,
  };
}

// Decide whether/how to rebalance toward the target split.
// midXinY = STX per 1 sBTC (from on-chain reserves).
export function decide(
  inv: Inventory,
  midXinY: number,
  params: AgentParams,
): Decision {
  const sbtcH = Number(inv.sbtcBase) / 1e8;
  const stxH = Number(inv.stxMicro) / 1e6;
  const sbtcValueStx = sbtcH * midXinY;
  const stxValueStx = stxH;
  const totalStx = sbtcValueStx + stxValueStx;
  const stxFraction = totalStx > 0 ? stxValueStx / totalStx : 0;
  const drift = stxFraction - params.targetStxFraction;
  const metrics = { sbtcValueStx, stxValueStx, totalStx, stxFraction, drift };

  if (totalStx <= 0) {
    return { action: "none", amountBase: 0n, reason: "no inventory", metrics };
  }
  const band = params.rebalanceBandBps / 10_000;
  if (Math.abs(drift) <= band) {
    return {
      action: "none",
      amountBase: 0n,
      reason: `within band (|drift| ${(Math.abs(drift) * 100).toFixed(2)}% ≤ ${(band * 100).toFixed(2)}%)`,
      metrics,
    };
  }

  if (drift > 0) {
    // too much STX → buy sBTC: swap (drift*total) STX worth
    const stxToSwap = drift * totalStx;
    let amt = BigInt(Math.round(stxToSwap * 1e6));
    if (amt > params.maxSwapStxUstx) amt = params.maxSwapStxUstx;
    return {
      action: "swap-y-for-x",
      amountBase: amt,
      reason: `STX share ${(stxFraction * 100).toFixed(1)}% > target ${(params.targetStxFraction * 100).toFixed(0)}% → buy sBTC`,
      metrics,
    };
  }
  // too much sBTC → sell sBTC for STX
  const sbtcToSwap = (-drift * totalStx) / midXinY;
  let amt = BigInt(Math.round(sbtcToSwap * 1e8));
  if (amt > params.maxSwapSbtcBase) amt = params.maxSwapSbtcBase;
  return {
    action: "swap-x-for-y",
    amountBase: amt,
    reason: `sBTC share ${((1 - stxFraction) * 100).toFixed(1)}% > target → sell sBTC`,
    metrics,
  };
}
