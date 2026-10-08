// DeepStack agent — the deterministic decision core (pair-agnostic).
//
// On a full-range XYK pool there is no concentrated range, so the v1 agent keeps a
// target x/y inventory value-split and rebalances via swaps when it drifts outside a
// band. Value is measured in the QUOTE (y) asset. Pure functions (no I/O), so they are
// reproducible and the AI layer only feeds parameters. Token decimals are passed in so
// the same logic serves any pair (sBTC-STX, STX-aeUSDC, ...).

export interface AgentParams {
  targetYFraction: number; // target value share held in the quote (y) asset (0..1)
  rebalanceBandBps: number; // drift tolerance before acting (bps)
  maxSwapYBase: bigint; // cap on a single y->x swap (y base units)
  maxSwapXBase: bigint; // cap on a single x->y swap (x base units)
  slippageBps: number;
  // --- liquidity provision (earns the pool fee). Opt-in: 0 disables LPing. ---
  targetLpFraction: number;
  lpBandBps: number;
  maxAddXBase: bigint; // cap on a single add-liquidity (x base units)
  maxWithdrawLpBase: bigint; // cap on a single withdraw (LP base, 6dp)
}

export interface LpDecision {
  action: "none" | "add-liquidity" | "withdraw-liquidity";
  xBase: bigint; // for add-liquidity: x to provide (paired y pulled by the pool)
  lpBase: bigint; // for withdraw-liquidity: LP tokens to burn
  reason: string;
}

export interface Inventory {
  xBase: bigint;
  yBase: bigint;
}

export interface Decision {
  action: "none" | "swap-y-for-x" | "swap-x-for-y";
  amountBase: bigint; // y base for swap-y-for-x; x base for swap-x-for-y — clamped to the per-swap cap
  // The true size needed to close the drift, BEFORE the per-swap cap clamps it. Equal to
  // amountBase whenever the uncapped need is already under the cap. Exists so a caller can
  // tell "drift needed X, capped to Y" apart from "drift only ever needed Y" — the direct-swap
  // path alone can't act on the difference (its cap is a real safety limit), but it's the
  // trigger for a larger mechanism with its own protections (flash-rebalance) to pick up
  // the rest instead of the cap silently truncating every cycle (found 2026-10-02: the
  // amountBase > cap refusal check in agent-cli.ts's act() could never fire, since amountBase
  // was always already clamped before reaching it — the real prior behavior was a silently
  // undersized correction, not a refusal).
  uncappedAmountBase: bigint;
  reason: string;
  metrics: { xValueY: number; yValueY: number; totalY: number; yFraction: number; drift: number };
}

export function defaultParams(): AgentParams {
  return {
    targetYFraction: 0.5,
    rebalanceBandBps: 500, // 5%
    maxSwapYBase: 50_000_000n, // e.g. 50 STX when y is STX
    maxSwapXBase: 150_000n,
    slippageBps: 100,
    targetLpFraction: Number(process.env.TARGET_LP_FRACTION ?? 0),
    lpBandBps: 1000, // 10%
    maxAddXBase: 30_000n,
    maxWithdrawLpBase: 100_000_000n,
  };
}

/**
 * Rebalance band derived from realised volatility, rather than guessed per regime.
 *
 * Every rebalance pays the pool fee, so the band is a fee budget: too tight and the agent
 * churns on noise, too wide and inventory risk runs unchecked. A FIXED band does not mean
 * the same thing across regimes — in a calm market it is never touched, in a violent one
 * it is crossed constantly — so the natural unit is volatility, not percent.
 *
 * Near a 50/50 split the y-fraction responds to the mid at a known rate. With
 * f = y / (y + x*m), df/d(ln m) = -(y*x*m)/(y + x*m)^2, which at balance (y = x*m) is
 * exactly -1/4. So a mid log-return r moves the fraction by about r/4, and a drift band
 * of B corresponds to a mid move of roughly 4B.
 *
 * Expressing the band as a number of daily sigmas of MID movement therefore keeps the
 * expected rebalance frequency — and so the fee spend — roughly constant across regimes:
 *
 *     band = sigmasTolerated * sigmaDaily / 4
 *
 * Calibration note: at sigmasTolerated = 6 this reproduces the AI layer's own qualitative
 * mapping almost exactly (2%/day vol -> ~300bps "calm", 6%/day -> ~900bps "volatile"),
 * which is a good sign that the LLM was approximating this relationship all along. Now the
 * measurement does it directly and the LLM is left proposing risk appetite inside clamps.
 *
 * Clamped: volatility estimates from sparse samples are noisy, and an unbounded band is a
 * risk control that can silently switch itself off.
 */
export function bandBpsFromVol(
  sigmaDaily: number,
  sigmasTolerated = 6,
  floorBps = 300,
  ceilingBps = 900,
): number {
  if (!(sigmaDaily > 0) || !(sigmasTolerated > 0)) return floorBps;
  const raw = ((sigmasTolerated * sigmaDaily) / 4) * 10_000;
  return Math.round(Math.min(ceilingBps, Math.max(floorBps, raw)));
}

/**
 * Exit-liquidity guard: would this add push our LP position above the pool-share cap?
 *
 * IL is a market risk; being a large share of a SHRINKING pool is a structural one — a
 * position you cannot unwind without moving the price against yourself, in a pool whose
 * other LPs may leave first. The cap bounds our share of the pool AFTER the add (both
 * numerator and denominator grow by the added value). Default 2%; env MAX_POOL_SHARE_BPS.
 */
export function exceedsPoolShare(
  lpValueY: number,
  addValueY: number,
  poolValueY: number,
  capBps = Number(process.env.MAX_POOL_SHARE_BPS ?? 200),
): boolean {
  if (!(poolValueY > 0)) return true; // no readable pool value → refuse to grow
  return (lpValueY + addValueY) / (poolValueY + addValueY) > capBps / 10_000;
}

export interface ExecTiming {
  execute: boolean;
  edgeBps: number; // execution edge vs the external mid (+ = the pool pays us to trade)
  reason: string;
}

/**
 * Divergence-aware execution timing — capture edge on trades we must make anyway.
 *
 * The rebalance band decides WHETHER to trade; this decides WHEN. A required buy of x
 * executed while the pool underprices x (vs the external mid) fills at a discount; the
 * same trade at an unfavourable divergence donates the edge to the pool's arbitrageurs.
 * So: execute immediately when the edge is favourable, defer a BOUNDED number of cycles
 * when it isn't, and never let optimisation outrank risk — urgent drift or an exhausted
 * defer budget executes regardless. Changes when, never whether or how much.
 */
export function decideExecTiming(
  action: "swap-y-for-x" | "swap-x-for-y",
  midXinY: number,
  externalMid: number | null,
  deferCount: number,
  driftUrgent: boolean,
  minEdgeBps = Number(process.env.EXEC_MIN_EDGE_BPS ?? 0),
  maxDefer = Number(process.env.EXEC_MAX_DEFER ?? 6),
): ExecTiming {
  if (externalMid === null || !(externalMid > 0) || !(midXinY > 0)) {
    return { execute: true, edgeBps: 0, reason: "no external reference — execute" };
  }
  // Buying x wants the pool cheap (ext > mid); selling x wants it rich (mid > ext).
  const edgeBps =
    action === "swap-y-for-x"
      ? (externalMid / midXinY - 1) * 10_000
      : (midXinY / externalMid - 1) * 10_000;
  if (driftUrgent) return { execute: true, edgeBps, reason: "drift urgent — risk outranks timing" };
  if (edgeBps >= minEdgeBps) return { execute: true, edgeBps, reason: `favourable ${edgeBps.toFixed(0)}bps edge` };
  if (deferCount >= maxDefer) return { execute: true, edgeBps, reason: `defer budget exhausted (${deferCount})` };
  return { execute: false, edgeBps, reason: `unfavourable ${edgeBps.toFixed(0)}bps — defer ${deferCount + 1}/${maxDefer}` };
}

// Rebalance the free inventory toward the target y-value split.
export function decide(
  inv: Inventory,
  midXinY: number, // y per 1 x
  xDecimals: number,
  yDecimals: number,
  params: AgentParams,
): Decision {
  const xH = Number(inv.xBase) / 10 ** xDecimals;
  const yH = Number(inv.yBase) / 10 ** yDecimals;
  const xValueY = xH * midXinY;
  const yValueY = yH;
  const totalY = xValueY + yValueY;
  const yFraction = totalY > 0 ? yValueY / totalY : 0;
  const drift = yFraction - params.targetYFraction;
  const metrics = { xValueY, yValueY, totalY, yFraction, drift };

  if (totalY <= 0) return { action: "none", amountBase: 0n, uncappedAmountBase: 0n, reason: "no inventory", metrics };

  const band = params.rebalanceBandBps / 10_000;
  if (Math.abs(drift) <= band) {
    return {
      action: "none",
      amountBase: 0n,
      uncappedAmountBase: 0n,
      reason: `within band (|drift| ${(Math.abs(drift) * 100).toFixed(2)}% ≤ ${(band * 100).toFixed(2)}%)`,
      metrics,
    };
  }

  if (drift > 0) {
    // too much y -> buy x: swap (drift*total) of y
    const uncapped = BigInt(Math.round(drift * totalY * 10 ** yDecimals));
    const amt = uncapped > params.maxSwapYBase ? params.maxSwapYBase : uncapped;
    return {
      action: "swap-y-for-x",
      amountBase: amt,
      uncappedAmountBase: uncapped,
      reason: `y share ${(yFraction * 100).toFixed(1)}% > target ${(params.targetYFraction * 100).toFixed(0)}% → buy x`,
      metrics,
    };
  }
  // too much x -> sell x for y
  const xToSwap = (-drift * totalY) / midXinY;
  const uncapped = BigInt(Math.round(xToSwap * 10 ** xDecimals));
  const amt = uncapped > params.maxSwapXBase ? params.maxSwapXBase : uncapped;
  return {
    action: "swap-x-for-y",
    amountBase: amt,
    uncappedAmountBase: uncapped,
    reason: `x share ${((1 - yFraction) * 100).toFixed(1)}% > target → sell x`,
    metrics,
  };
}

// Move toward the target LP allocation (value in y). Conservative + multi-step:
// gap-sized add (half the gap in x), bounded by available x and paired y.
export function decideLp(
  portfolioY: number,
  lpBalanceBase: bigint,
  lpValueY: number,
  availXBase: bigint,
  availYBase: bigint,
  midXinY: number,
  xDecimals: number,
  yDecimals: number,
  params: AgentParams,
): LpDecision {
  if (params.targetLpFraction <= 0 || portfolioY <= 0) {
    return { action: "none", xBase: 0n, lpBase: 0n, reason: "LP disabled (targetLpFraction=0)" };
  }
  const targetLp = params.targetLpFraction * portfolioY;
  const band = (params.lpBandBps / 10_000) * portfolioY;

  if (lpValueY < targetLp - band) {
    const xValueToAdd = (targetLp - lpValueY) / 2; // half the gap, in y value
    let xBase = BigInt(Math.floor((xValueToAdd / midXinY) * 10 ** xDecimals));
    if (xBase > availXBase) xBase = availXBase;
    // bound by paired y available (leave a 2% headroom on the y leg)
    const availYH = (Number(availYBase) / 10 ** yDecimals) * 0.98;
    const affordableXBase = BigInt(Math.floor((availYH / midXinY) * 10 ** xDecimals));
    if (affordableXBase < xBase) xBase = affordableXBase;
    if (xBase > params.maxAddXBase) xBase = params.maxAddXBase;
    if (xBase <= 0n) {
      return { action: "none", xBase: 0n, lpBase: 0n, reason: "under LP target but insufficient paired inventory" };
    }
    return {
      action: "add-liquidity",
      xBase,
      lpBase: 0n,
      reason: `LP ${((lpValueY / portfolioY) * 100).toFixed(1)}% < target ${(params.targetLpFraction * 100).toFixed(0)}% → add`,
    };
  }

  if (lpValueY > targetLp + band && lpBalanceBase > 0n) {
    const removeFrac = Math.min(1, (lpValueY - targetLp) / lpValueY);
    let lp = BigInt(Math.floor(Number(lpBalanceBase) * removeFrac));
    if (lp > params.maxWithdrawLpBase) lp = params.maxWithdrawLpBase;
    if (lp <= 0n) {
      return { action: "none", xBase: 0n, lpBase: 0n, reason: "over LP target but withdraw rounds to zero" };
    }
    return {
      action: "withdraw-liquidity",
      xBase: 0n,
      lpBase: lp,
      reason: `LP ${((lpValueY / portfolioY) * 100).toFixed(1)}% > target ${(params.targetLpFraction * 100).toFixed(0)}% → withdraw`,
    };
  }

  return { action: "none", xBase: 0n, lpBase: 0n, reason: "LP within band" };
}

// Whether the DLMM step is allowed to broadcast this cycle. Kept as a pure function
// (agent-cli.ts's main() computes the inputs and calls this) specifically so it's directly
// testable — `safe` used to be missing from this gate entirely (see the Sep 2026 external
// review finding: DLMM only checked the kill switch and nonce safety, not oracle
// divergence/drawdown/pool-paused), and that class of bug is exactly what a unit test on the
// gate itself catches that a passing live cycle under normal conditions would not.
export function dlmmLiveGate(opts: {
  dlmmLiveFlag: boolean;
  live: boolean;
  circuitOk: boolean;
  safe: boolean;
  dlmmFailStreak: number;
  dlmmFailStreakLimit: number;
  dlmmRecenters: number;
  maxTrades: number;
}): boolean {
  return (
    opts.dlmmLiveFlag &&
    opts.live &&
    opts.circuitOk &&
    opts.safe &&
    opts.dlmmFailStreak < opts.dlmmFailStreakLimit &&
    opts.dlmmRecenters < opts.maxTrades
  );
}

// XYK's analogue of dlmmLiveGate() above — the composed condition that must hold before
// the rebalance/LP leg is allowed to broadcast this tick (agent-cli.ts used to inline this
// as `live && circuitOk && trades < f.maxTrades`). Extracted and tested for the same reason:
// an inline composed boolean is easy to get subtly wrong (wrong operator, a dropped term) in
// a way a passing live cycle under normal conditions would never surface (external review,
// issue #7 — "safety-critical orchestration paths ... untested").
export function xykLiveGate(opts: { live: boolean; circuitOk: boolean; trades: number; maxTrades: number }): boolean {
  return opts.live && opts.circuitOk && opts.trades < opts.maxTrades;
}

export interface DlmmCounters {
  failStreak: number;
  recenters: number;
}

// How dlmmFailStreak/dlmmRecenters evolve after one DLMM cycle — the state machine behind
// the restart-survival fix (external review, issue #6). Both of agent-cli.ts's call sites
// (a normal cycle's outcome, and the catch block's "a thrown add is still a real failed
// attempt" case) reduce to this one transition. Pure so the exact rules — reset-on-success,
// increment only on a real attempt, recenters only climbs on success — are unit-tested
// without a live chain, a wallet, or the filesystem (external review, issue #7).
export function nextDlmmCounters(current: DlmmCounters, outcome: { executed: boolean; attempted: boolean }): DlmmCounters {
  return {
    failStreak: outcome.executed ? 0 : outcome.attempted ? current.failStreak + 1 : current.failStreak,
    recenters: outcome.executed ? current.recenters + 1 : current.recenters,
  };
}

// The autonomous flash-rebalance gate — same family as dlmmLiveGate/xykLiveGate above, same
// shape of risk (a dropped term in a composed boolean that a normal passing cycle would never
// surface). Gates the "drift exceeds the direct-swap cap, use FlashStack to cover the rest"
// path in agent-cli.ts's act(). `safe` is the SAME oracle-divergence/drawdown/pool-paused
// check the XYK and DLMM paths already share — a flash-rebalance is a real broadcast, it does
// not get a lighter safety bar than a plain swap just because it uses a different mechanism.
// Routing rule for the autonomous flash rebalance (2026-10-08). The deployed receiver
// (deepstack-rebalance-receiver.clar) repays the loan from the agent's OWN STX, and the
// executor caps every loan at that STX (sizeFlashRebalance's usable-balance clamp). So a flash
// rebalance can never move more than a direct swap funded by the same STX would. Measured on
// mainnet (4 runs, 2026-10-07/08, 51.7-75.3 STX): each cost ~0.08 STX more than one direct
// swap (a second transaction plus the 0.05% loan fee), and it raised the per-trade limit on
// buying sBTC from maxSwapYBase (50 STX) to FLASH_MAX_SWAP_Y_BASE (150 STX) for exactly the
// same market risk. It also generated FlashStack volume funded entirely by our own capital.
// The flash route is therefore used only with a receiver that ADDS capacity, i.e. repays from
// something other than the agent's own STX (a cross-venue leg; see docs/FLASH_REBALANCE.md).
// Flip this only when such a receiver is deployed and audited.
export const FLASH_RECEIVER_ADDS_CAPACITY = false;

export function useFlashRoute(o: { overCap: boolean; action: string; receiverAddsCapacity: boolean }): boolean {
  return o.overCap && o.action === "swap-y-for-x" && o.receiverAddsCapacity;
}

export function flashLiveGate(opts: {
  flashLiveFlag: boolean;
  live: boolean;
  circuitOk: boolean;
  safe: boolean;
  flashFailStreak: number;
  flashFailStreakLimit: number;
  flashAttempts: number;
  maxTrades: number;
}): boolean {
  return (
    opts.flashLiveFlag &&
    opts.live &&
    opts.circuitOk &&
    opts.safe &&
    opts.flashFailStreak < opts.flashFailStreakLimit &&
    opts.flashAttempts < opts.maxTrades
  );
}

export interface FlashCounters {
  failStreak: number;
  attempts: number;
}

// Same transition rules as nextDlmmCounters, same reason: a flash-rebalance attempt and a
// DLMM recenter attempt are structurally the same kind of event (a gated broadcast that
// either lands, fails, or never gets tried this cycle), so the state machine is identical.
export function nextFlashCounters(current: FlashCounters, outcome: { executed: boolean; attempted: boolean }): FlashCounters {
  return {
    failStreak: outcome.executed ? 0 : outcome.attempted ? current.failStreak + 1 : current.failStreak,
    attempts: outcome.executed ? current.attempts + 1 : current.attempts,
  };
}
