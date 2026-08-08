// DLMM recenter decision core (pure, no I/O — the concentrated-liquidity analog of agent.ts
// decide()). A concentrated position covers a band of bins around some center. As price moves
// the active bin drifts; once it leaves the band the position is fully one-sided and earns
// nothing at the current price, so it must be withdrawn and re-added around the new active bin.
//
// This module decides ONLY: open / hold / recenter, and the target bin band. Execution (the
// withdraw → rebalance → re-add sequence, and on-chain share quotes) lives in the executor and
// the agent loop; keeping the decision pure means it is reproducible and unit-tested, and the AI
// layer can inform the width (via binRangeFromVol) without ever touching capital.

export interface PositionRange {
  lo: number | null; // lowest signed bin held (null = no position)
  hi: number | null; // highest signed bin held
}

export interface RecenterDecision {
  action: "open" | "hold" | "recenter";
  reason: string;
  targetLo: number; // desired band for open/recenter
  targetHi: number;
  center: number; // desired center (= active bin)
}

/**
 * Decide whether a concentrated position should be (re)centered on the active bin.
 *
 *  - no position            → OPEN a band of ±halfWidth around the active bin
 *  - active within the band  → HOLD (still earning across the current bins)
 *  - active drifted past the band edge (+ hysteresis) → RECENTER on the active bin
 *
 * `hysteresisBins` requires the active bin to move a little BEYOND the edge before recentering,
 * so price oscillating on the boundary doesn't thrash (each recenter costs fees + realizes IL).
 * Symmetric band: a position centered at C spans [C-halfWidth, C+halfWidth], so drifting more
 * than halfWidth from the current center means the active bin has left the band.
 */
export function decideRecenter(
  activeBin: number,
  position: PositionRange,
  halfWidth: number,
  hysteresisBins = 1,
): RecenterDecision {
  const hw = Math.max(1, Math.floor(halfWidth));
  const targetLo = activeBin - hw;
  const targetHi = activeBin + hw;
  const base = { targetLo, targetHi, center: activeBin };

  if (position.lo === null || position.hi === null) {
    return { action: "open", reason: `no position — open ±${hw} bins around active ${activeBin}`, ...base };
  }
  const center = Math.round((position.lo + position.hi) / 2);
  const drift = Math.abs(activeBin - center);
  if (drift > hw + Math.max(0, Math.floor(hysteresisBins))) {
    return {
      action: "recenter",
      reason: `active ${activeBin} drifted ${drift} bins from center ${center} (band ±${hw}) — recenter`,
      ...base,
    };
  }
  return {
    action: "hold",
    reason: `active ${activeBin} within band of center ${center} (drift ${drift} ≤ ${hw}+${hysteresisBins})`,
    ...base,
  };
}

/**
 * min-dlp for an add: expected LP shares minus slippage, never below the pool's share floor
 * (minimum-bin-shares, 10000 on-chain — a deposit that would mint fewer aborts anyway, so
 * clamping up to the floor keeps the guard valid rather than accidentally zero). The core also
 * rejects min-dlp = 0, so the floor doubles as the "> 0" guarantee.
 */
export function minDlpFromExpected(expectedShares: bigint, slippageBps: number, floor: bigint): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))));
  const afterSlip = expectedShares - (expectedShares * bps) / 10_000n;
  return afterSlip > floor ? afterSlip : floor;
}

/**
 * min-out for a withdraw leg: expected token amount minus slippage. The core requires
 * min-x + min-y > 0 per bin, so callers must ensure the side that holds value gets a positive
 * min; a zero expected amount (the empty side of a single-sided bin) correctly yields 0 here.
 */
export function minOutFromExpected(expectedAmount: bigint, slippageBps: number): bigint {
  if (expectedAmount <= 0n) return 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))));
  const out = expectedAmount - (expectedAmount * bps) / 10_000n;
  return out > 0n ? out : 1n; // a value-bearing side must assert at least 1 (min-sum > 0 rule)
}

export interface TwoSidedSize {
  xBase: bigint; // STX for the X (above-active) side, µSTX
  yBase: bigint; // USDCx for the Y (below-active) side, 6dp
  valueUsd: number; // realised total value the sizing actually places (after balance caps)
}

/**
 * Size a ~50/50-by-value two-sided deposit from available balances, capped by a target.
 *
 * v1 recenter is balance-funded, NOT swap-rebalanced (the DLMM swap has no min-out — see
 * dlmm-recenter notes), so each side is whatever the wallet can supply up to half the target
 * value. If one token is short the position is placed lopsided rather than swapping to top up;
 * that is honest LP drift, and it is reported, not hidden. x = STX (native, 6dp @ stxPriceUsd),
 * y = USDCx (6dp, ≈ $1). Pure.
 */
export function sizeTwoSidedDeposit(
  targetValueUsd: number,
  stxPriceUsd: number,
  availStxBase: bigint, // already net of the gas reserve the caller wants to keep
  availUsdcxBase: bigint,
): TwoSidedSize {
  if (!(targetValueUsd > 0) || !(stxPriceUsd > 0)) return { xBase: 0n, yBase: 0n, valueUsd: 0 };
  const halfUsd = targetValueUsd / 2;
  let yBase = BigInt(Math.floor(halfUsd * 1e6)); // USDCx ≈ $1
  let xBase = BigInt(Math.floor((halfUsd / stxPriceUsd) * 1e6)); // STX worth ~halfUsd
  if (yBase > availUsdcxBase) yBase = availUsdcxBase < 0n ? 0n : availUsdcxBase;
  if (xBase > availStxBase) xBase = availStxBase < 0n ? 0n : availStxBase;
  const valueUsd = (Number(xBase) / 1e6) * stxPriceUsd + Number(yBase) / 1e6;
  return { xBase, yBase, valueUsd };
}
