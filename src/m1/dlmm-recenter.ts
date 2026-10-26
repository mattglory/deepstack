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

// y per x, scaled by PRICE_SCALE_BPS — the core contract's own fixed-point convention
// (SP1PFR4V…dlmm-core-v-1-1, verified against its live source 2026-09-21).
const PRICE_SCALE = 100_000_000n;

function sqrtBig(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
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
 *  - no position                                    → OPEN ±halfWidth around the active bin
 *  - active inside the bins the position really holds → HOLD (still earning)
 *  - active beyond the position's edge (+ hysteresis)  → RECENTER ±halfWidth on the active bin
 *
 * The trigger is the position's REAL edges (position.lo / position.hi as held on-chain), never
 * halfWidth. halfWidth only sizes the NEXT position. They used to be the same number: drift
 * from the position's center was compared against the current halfWidth, which silently assumed
 * every position is exactly ±halfWidth wide. It isn't. halfWidth is recomputed every cycle from
 * live volatility, and positions get opened at other widths (the manual CLI's ±3 fallback). On
 * 2026-10-07 that stranded a 7-bin position [236..242] out of range for 10+ hours: active bin
 * 233, then 231, sat 6-8 bins from center 239 and was judged "within band" of a ±50 vol band.
 * The mirror failure existed too: a wide position opened in a volatile week would be withdrawn
 * and re-added while still in range once volatility, and so halfWidth, fell.
 *
 * `hysteresisBins` requires the active bin to move a little BEYOND the edge before recentering,
 * so price oscillating on the boundary doesn't thrash (each recenter costs fees + realizes IL).
 */
/**
 * Cost basis after a recenter (2026-10-12). A recenter withdraws the whole position and re-adds
 * it, and the re-add can be larger or smaller than what came out (the agent sizes it to its
 * target from free wallet balances). The difference is capital moved in or out, not profit, so
 * the basis legs move by exactly that difference. P&L (value of the position minus value of the
 * basis, at the same prices) is then unchanged across the recenter. Legs may go negative; that
 * is correct for continuity, since valuation is linear. Found live: the 2026-10-08 recenter
 * topped the position up from ~$199 to ~$596, and without this the dashboard showed the
 * ~$400 of added capital as +1,438 STX of DLMM profit.
 */
export function adjustBasisForRecenter<T extends { xQty: number; yQty: number }>(
  prev: T,
  before: { x: number; y: number },
  after: { x: number; y: number },
): T {
  return { ...prev, xQty: prev.xQty + after.x - before.x, yQty: prev.yQty + after.y - before.y };
}

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
  const h = Math.max(0, Math.floor(hysteresisBins));
  const range = `[${position.lo}..${position.hi}]`;
  // How many bins the active bin sits beyond the nearest edge of what's actually held
  // (<= 0 means it's inside the position).
  const below = position.lo - activeBin;
  const above = activeBin - position.hi;
  const outside = Math.max(below, above);
  if (outside > h) {
    return {
      action: "recenter",
      reason: `active ${activeBin} is ${outside} bins ${below > 0 ? "below" : "above"} the position ${range} (hysteresis ${h}) — recenter ±${hw}`,
      ...base,
    };
  }
  return {
    action: "hold",
    reason: outside > 0 ? `active ${activeBin} is ${outside} bin(s) outside the position ${range}, within hysteresis ${h}` : `active ${activeBin} inside the position ${range}`,
    ...base,
  };
}

/**
 * Expected LP shares (dlp) a deposit of (xAmount, yAmount) mints in one bin — mirrors the core
 * contract's add-liquidity formula exactly (verified against its live source, 2026-09-21):
 * sqrt(value) minus the one-time burn for a bin's first-ever deposit (bin-shares == 0), or a
 * value-proportional share of the bin's existing shares otherwise. Deliberately does NOT model
 * the small liquidity-fee deduction the core applies at the ACTIVE bin only — that second-order
 * effect is what minDlpFromExpected's slippage margin exists to absorb, not a math error here.
 */
export function expectedDlp(
  xAmount: bigint,
  yAmount: bigint,
  bin: { xBalance: bigint; yBalance: bigint; binShares: bigint; binPrice: bigint },
  minimumBurntShares: bigint,
): bigint {
  const addValue = bin.binPrice * xAmount + yAmount * PRICE_SCALE;
  if (bin.binShares === 0n) {
    const intended = sqrtBig(addValue);
    return intended > minimumBurntShares ? intended - minimumBurntShares : 0n;
  }
  const binValue = bin.binPrice * bin.xBalance + bin.yBalance * PRICE_SCALE;
  if (binValue === 0n) return sqrtBig(addValue);
  return (addValue * bin.binShares) / binValue;
}

/**
 * min-dlp for an add: expected LP shares minus a slippage margin (covers price movement between
 * sizing and confirmation), never below `floor`. The core's own minimum-bin-shares check ONLY
 * applies when a bin's dlp-post-fees is computed via the bin-shares==0 branch (a genuinely empty
 * bin) — for every other bin, min-dlp is a caller-supplied guard with no protocol-enforced floor
 * beyond "> 0". Callers must pass the RIGHT floor per bin (minimumBinShares for an empty bin, 1n
 * otherwise) — see expectedDlp's caller in dlmm-recenter-exec.ts. The core also rejects
 * min-dlp = 0 outright, so a floor of at least 1n is required regardless.
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
  xPriceUsd: number, // USD price of the X token (STX for stx-usdcx, BTC for sbtc-usdcx)
  availXBase: bigint, // X available, in X base units, net of any reserve the caller keeps
  availYBase: bigint, // Y (USDCx) available, in Y base units
  xDecimals = 6, // X token decimals (STX/USDCx = 6, sBTC = 8)
  yDecimals = 6, // Y (USDCx) decimals
): TwoSidedSize {
  if (!(targetValueUsd > 0) || !(xPriceUsd > 0)) return { xBase: 0n, yBase: 0n, valueUsd: 0 };
  const halfUsd = targetValueUsd / 2;
  const xUnit = 10 ** xDecimals, yUnit = 10 ** yDecimals;
  let yBase = BigInt(Math.floor(halfUsd * yUnit)); // Y is USDCx ≈ $1
  let xBase = BigInt(Math.floor((halfUsd / xPriceUsd) * xUnit)); // X worth ~halfUsd
  if (yBase > availYBase) yBase = availYBase < 0n ? 0n : availYBase;
  if (xBase > availXBase) xBase = availXBase < 0n ? 0n : availXBase;
  const valueUsd = (Number(xBase) / xUnit) * xPriceUsd + Number(yBase) / yUnit;
  return { xBase, yBase, valueUsd };
}

export interface RecenterSequenceOutcome {
  executed: boolean;
  reason: string;
  attemptedReAdd: boolean;
}

/**
 * Pure interpretation of a recenter's two-step broadcast sequence (withdraw ALL bins, then
 * conditionally re-add centered on the new active bin). The sequencing RULE itself, not the
 * broadcasting mechanics around it: a withdraw that doesn't confirm successfully must abort
 * before ever attempting the re-add — funds stay as loose tokens in the wallet (no half-built
 * position) rather than retrying or partially proceeding. Extracted from
 * dlmm-recenter-exec.ts's recenterOnce() so this property is unit-tested without a live
 * chain, a wallet, or a broadcast (external review, issue #7 — "broadcast sequencing and
 * nonce handling ... untested").
 *
 * `addStatus` is null when no re-add was attempted (i.e. the withdraw itself already failed);
 * the caller never calls this with a null addStatus after a successful withdraw in practice,
 * but the null case still fails closed rather than claim an executed recenter with no evidence.
 */
export function recenterSequenceOutcome(withdrawStatus: string, addStatus: string | null): RecenterSequenceOutcome {
  if (withdrawStatus !== "success") {
    return { executed: false, reason: `withdraw ${withdrawStatus} — aborted before re-add (funds safe in wallet)`, attemptedReAdd: false };
  }
  if (addStatus === null) {
    return { executed: false, reason: "withdraw succeeded but no re-add was attempted", attemptedReAdd: false };
  }
  return { executed: addStatus === "success", reason: addStatus === "success" ? "recentered" : `re-add ${addStatus}`, attemptedReAdd: true };
}

// ---------------------------------------------------------------------------------------------
// Realised volatility from the pool's OWN active bin (added 2026-10-15).
//
// The width used to come from an implied BTC/USD series: the sBTC-STX XYK mid times the STX/USD
// price, both read every 30 minutes. Each leg carries its own noise and the product compounds it,
// so that series measured ~4.5%/day while the sbtc-usdcx pool's real active bin, replayed from
// 44 days of the agent's own journal (2,052 readings), moved ~1.9%/day. The inflated figure
// pinned the width at the ±50 cap. The active bin IS the pool's price on a log scale:
// price ∝ (1 + binStep/1e4)^bin, so log-return between two samples = Δbin · ln(1 + binStep/1e4).
//
// Needs `minPoints` readings (default 96 ≈ 2 days at the 30-min cadence) before it returns a
// number; until then the caller falls back to the old series, as before. A read failure is
// simply absent from the series (never a fake bin), so a gap becomes one longer interval and
// the time weighting absorbs it.
export interface BinSample { t: string; bin: number; binStep: number }

export function binSeriesVolDaily(samples: BinSample[], minPoints = 96): number | null {
  const pts = samples.filter((s) => Number.isInteger(s.bin) && s.bin >= 0 && s.binStep > 0);
  if (pts.length < minPoints) return null;
  let sumR2 = 0;
  let sumDt = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.binStep !== b.binStep) continue; // a different pool, not a price move
    const dtDays = (Date.parse(b.t) - Date.parse(a.t)) / 86_400_000;
    if (!(dtDays > 0)) continue;
    const r = (b.bin - a.bin) * Math.log(1 + a.binStep / 10_000);
    sumR2 += r * r;
    sumDt += dtDays;
  }
  return sumDt > 0 ? Math.sqrt(sumR2 / sumDt) : null;
}

// ---------------------------------------------------------------------------------------------
// Keep the whole position through a recenter (2026-10-26).
//
// When price runs through a position, the bins it crossed convert to one token: a fall turns the
// USDCx bins into sBTC. The re-add used to size itself 50/50 from wallet balances, so it was
// limited by the scarce side and left the surplus loose. On 2026-10-26 a recenter shrank the
// position from ~$597 to ~$352, and the XYK rebalancer then sold the loose sBTC through the thin
// sBTC/STX pool. Re-adding the surplus one-sided instead is not a fix either: a one-sided range
// sits entirely on one side of the price and drifts out again after a single bin, so the agent
// would recenter every cycle in a trend.
//
// So: swap half of the imbalance back across, in the SAME pool, through the router's
// minimum-output swap, then re-add everything. This plans that swap. Amounts are base units;
// priceYPerX is human Y per human X (USDCx per sBTC). No swap when the split is already within
// `toleranceFrac` of 50/50 of total value.
export interface RebalanceSwapPlan {
  direction: "x-for-y" | "y-for-x" | "none";
  amountIn: bigint; // base units of the input token
  minOut: bigint; // base units of the output token
}

export function planRebalanceSwap(
  xBase: bigint,
  yBase: bigint,
  priceYPerX: number,
  xDecimals: number,
  yDecimals: number,
  opts: { toleranceFrac?: number; slippageBps?: number } = {},
): RebalanceSwapPlan {
  const none: RebalanceSwapPlan = { direction: "none", amountIn: 0n, minOut: 0n };
  if (!(priceYPerX > 0) || xBase < 0n || yBase < 0n) return none;
  const tol = opts.toleranceFrac ?? 0.1;
  const slip = (opts.slippageBps ?? 100) / 10_000;
  const xu = 10 ** xDecimals, yu = 10 ** yDecimals;
  const xVal = (Number(xBase) / xu) * priceYPerX; // in Y
  const yVal = Number(yBase) / yu;
  const total = xVal + yVal;
  if (!(total > 0)) return none;
  const excess = xVal - total / 2; // > 0: too much X
  if (Math.abs(excess) <= tol * total) return none;
  if (excess > 0) {
    const amountIn = BigInt(Math.floor((excess / priceYPerX) * xu));
    const minOut = BigInt(Math.floor(excess * (1 - slip) * yu));
    return amountIn > 0n && amountIn <= xBase ? { direction: "x-for-y", amountIn, minOut } : none;
  }
  const amountIn = BigInt(Math.floor(-excess * yu));
  const minOut = BigInt(Math.floor((-excess / priceYPerX) * (1 - slip) * xu));
  return amountIn > 0n && amountIn <= yBase ? { direction: "y-for-x", amountIn, minOut } : none;
}

/** |pool - reference| / reference in bps; used to refuse a rebalance swap at a manipulated price. */
export function divergenceBps(poolPrice: number, referencePrice: number): number {
  return referencePrice > 0 ? Math.round((Math.abs(poolPrice - referencePrice) / referencePrice) * 10_000) : Infinity;
}
