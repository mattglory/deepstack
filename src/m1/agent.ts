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
  // --- liquidity provision (earns the pool fee). Opt-in: 0 disables LPing. ---
  targetLpFraction: number; // target share of portfolio value deployed as LP (0..1)
  lpBandBps: number; // tolerance before adding/withdrawing LP (bps)
  maxAddSbtcBase: bigint; // cap on a single add-liquidity (sBTC base, 8dp)
  maxWithdrawLpBase: bigint; // cap on a single withdraw (LP base, 6dp)
}

export interface LpDecision {
  action: "none" | "add-liquidity" | "withdraw-liquidity";
  sbtcBase: bigint; // for add-liquidity: sBTC to provide (paired STX pulled by the pool)
  lpBase: bigint; // for withdraw-liquidity: LP tokens to burn
  reason: string;
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
    // LP disabled by default; enable with TARGET_LP_FRACTION (e.g. 0.3)
    targetLpFraction: Number(process.env.TARGET_LP_FRACTION ?? 0),
    lpBandBps: 1000, // 10%
    maxAddSbtcBase: 30_000n, // 0.0003 sBTC per add
    maxWithdrawLpBase: 100_000_000n, // 100 LP per withdraw
  };
}

// Decide whether to add or withdraw liquidity to track the target LP allocation.
// Conservative + multi-step: each call moves toward the target within caps and
// available inventory (so it converges over cycles rather than one big move).
export function decideLp(
  portfolioStx: number, // total value (free inventory + LP), in STX
  lpBalanceBase: bigint, // current LP token balance (6 dp)
  lpValueStx: number, // current LP position value, in STX
  availSbtcBase: bigint, // free sBTC (8 dp)
  availStxMicro: bigint, // free STX (6 dp)
  midXinY: number, // STX per sBTC
  params: AgentParams,
): LpDecision {
  if (params.targetLpFraction <= 0 || portfolioStx <= 0) {
    return { action: "none", sbtcBase: 0n, lpBase: 0n, reason: "LP disabled (targetLpFraction=0)" };
  }
  const targetLp = params.targetLpFraction * portfolioStx;
  const band = (params.lpBandBps / 10_000) * portfolioStx;

  if (lpValueStx < targetLp - band) {
    // ADD: size to the gap (half the gap value in sBTC for a 50/50 pool), then
    // constrain by available sBTC, available paired STX (1 STX fee buffer), and cap.
    const sbtcValueToAdd = (targetLp - lpValueStx) / 2; // in STX value
    let sbtc = BigInt(Math.floor((sbtcValueToAdd / midXinY) * 1e8));
    if (sbtc > availSbtcBase) sbtc = availSbtcBase;
    const freeStxForLp = availStxMicro > 1_000_000n ? availStxMicro - 1_000_000n : 0n;
    const affordableByStx = BigInt(Math.floor((Number(freeStxForLp) / 1e6 / midXinY) * 1e8));
    if (affordableByStx < sbtc) sbtc = affordableByStx;
    if (sbtc > params.maxAddSbtcBase) sbtc = params.maxAddSbtcBase;
    if (sbtc <= 0n) {
      return { action: "none", sbtcBase: 0n, lpBase: 0n, reason: "under LP target but insufficient paired inventory" };
    }
    return {
      action: "add-liquidity",
      sbtcBase: sbtc,
      lpBase: 0n,
      reason: `LP ${((lpValueStx / portfolioStx) * 100).toFixed(1)}% < target ${(params.targetLpFraction * 100).toFixed(0)}% → add`,
    };
  }

  if (lpValueStx > targetLp + band && lpBalanceBase > 0n) {
    const removeFrac = Math.min(1, (lpValueStx - targetLp) / lpValueStx);
    let lp = BigInt(Math.floor(Number(lpBalanceBase) * removeFrac));
    if (lp > params.maxWithdrawLpBase) lp = params.maxWithdrawLpBase;
    if (lp <= 0n) {
      return { action: "none", sbtcBase: 0n, lpBase: 0n, reason: "over LP target but withdraw rounds to zero" };
    }
    return {
      action: "withdraw-liquidity",
      sbtcBase: 0n,
      lpBase: lp,
      reason: `LP ${((lpValueStx / portfolioStx) * 100).toFixed(1)}% > target ${(params.targetLpFraction * 100).toFixed(0)}% → withdraw`,
    };
  }

  return { action: "none", sbtcBase: 0n, lpBase: 0n, reason: "LP within band" };
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
