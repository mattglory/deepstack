// DLMM position model (step 2 of the concentrated-liquidity build — POST-PILOT, still reads only).
//
// A concentrated position is liquidity spread over a RANGE of bins around the price, not a single
// scalar LP share. This module (a) represents such a position, (b) reads a real one from chain,
// and (c) answers the decisive new question the XYK core never had to: HOW WIDE should the range
// be? The answer is volatility-driven — the same principle as the XYK vol-scaled band, but sized
// in BINS: spread liquidity wide enough to contain the expected price move between recenters, so
// the position doesn't fall out of range (and stop earning) every time price twitches.
//
// Still no writes. The add/move/withdraw path (step 3) and the flash-receiver (step 5) build on
// this. Pure math is split out and unit-tested; the on-chain read THROWS on any failed call
// rather than treating it as "no position here" — an incomplete read silently masquerading as
// a complete-but-smaller position is worse than a loud failure, since callers (recenter's
// withdraw list, in particular) trust this to be the whole position. Found the hard way: a
// rate-limited run once silently dropped 18 of 51 real bins from a withdrawal (2026-08-20).

import { fetchCallReadOnlyFunction, cvToJSON, Cl } from "@stacks/transactions";
import { withRpc, hiroFetch } from "./rpc.js";
import { binSignedId, type DlmmPool } from "./dlmm-read.js";

const DEPLOYER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";

export interface PositionBin {
  signedBin: number;
  userShares: bigint;
  userX: bigint; // the user's prorated share of this bin's x
  userY: bigint; // the user's prorated share of this bin's y
}

export interface DlmmPosition {
  pool: string;
  user: string;
  bins: PositionBin[];
  lowerSignedBin: number | null; // range edges (null if empty)
  upperSignedBin: number | null;
  totalX: bigint;
  totalY: bigint;
}

/** A user's prorated share of a bin's balances — integer math, floored (never over-credits). */
export function proratePosition(
  userShares: bigint,
  binShares: bigint,
  binX: bigint,
  binY: bigint,
): { x: bigint; y: bigint } {
  if (binShares <= 0n || userShares <= 0n) return { x: 0n, y: 0n };
  return { x: (userShares * binX) / binShares, y: (userShares * binY) / binShares };
}

export interface RangeOpts {
  kSigmas?: number; // std-devs of price move to contain (Arrakis ~95% containment ≈ 2)
  horizonHours?: number; // recenter horizon — how long the range must hold before a recenter
  maxHalfWidthBins?: number; // cap; the pool has 1001 bins so hard max is ±500
}

export interface BinRange {
  halfWidthBins: number; // bins each side of the active bin
  rangeBps: number; // total price width the range covers, in bps
}

/**
 * How wide (in bins) to spread a concentrated position, sized from volatility.
 *
 * A bin spans `binStepBps` of price. The expected 1-sigma price move over the recenter horizon
 * is `sigmaDaily * sqrt(horizonHours/24)`; we cover `kSigmas` of it each side. Converting that
 * price range to bins gives the half-width. Higher vol → wider range; finer bin-step → more bins
 * for the same price range. Clamped to at least 1 bin and at most the pool's half-capacity.
 *
 * This is the concentrated-liquidity analog of bandBpsFromVol (agent.ts): the same "let measured
 * volatility, not a guess, set the risk width" principle, expressed in bins instead of a drift band.
 */
export function binRangeFromVol(sigmaDaily: number, binStepBps: number, opts: RangeOpts = {}): BinRange {
  const k = opts.kSigmas ?? 2;
  const horizonHours = opts.horizonHours ?? 12;
  const cap = opts.maxHalfWidthBins ?? 500;
  if (!(sigmaDaily > 0) || !(binStepBps > 0)) return { halfWidthBins: 1, rangeBps: Math.max(1, Math.round(binStepBps)) };
  const priceStd = sigmaDaily * Math.sqrt(horizonHours / 24); // fraction of price, one sigma
  const halfRangeBps = k * priceStd * 10_000; // one side, in bps
  const halfWidthBins = Math.max(1, Math.min(cap, Math.ceil(halfRangeBps / binStepBps)));
  return { halfWidthBins, rangeBps: Math.round(halfRangeBps * 2) };
}

async function callRead(pool: DlmmPool, fn: string, args: any[]): Promise<any> {
  try {
    return cvToJSON(
      await withRpc((baseUrl) =>
        fetchCallReadOnlyFunction({
          contractAddress: DEPLOYER,
          contractName: pool.name,
          functionName: fn,
          functionArgs: args,
          network: "mainnet",
          client: { baseUrl, fetch: hiroFetch(baseUrl) },
          senderAddress: DEPLOYER,
        }),
      ),
    );
  } catch (err) {
    throw new Error(`readUserPosition: ${pool.key}.${fn} failed, position read is incomplete: ${(err as Error).message ?? err}`);
  }
}

/**
 * Read a user's concentrated position: their bins (via get-user-bins), their shares in each
 * (get-balance), and their prorated x/y (share of get-bin-balances). THROWS if any of those
 * calls fails — see the module comment for why a partial read must not look like a complete
 * empty-ish position. Callers that want to tolerate a transient miss (e.g. an observe-only
 * cycle) should catch at the call site, where "what to do if we don't know" is actually known.
 */
export async function readUserPosition(pool: DlmmPool, user: string): Promise<DlmmPosition> {
  const empty: DlmmPosition = { pool: pool.key, user, bins: [], lowerSignedBin: null, upperSignedBin: null, totalX: 0n, totalY: 0n };
  const ub = await callRead(pool, "get-user-bins", [Cl.principal(user)]);
  const list: any[] = ub?.value?.value ?? ub?.value ?? [];
  if (!Array.isArray(list) || list.length === 0) return empty;

  const bins: PositionBin[] = [];
  for (const item of list) {
    const uintKey = Number(item?.value ?? item);
    if (!Number.isFinite(uintKey)) continue;
    const [balJ, binJ] = await Promise.all([
      callRead(pool, "get-balance", [Cl.uint(uintKey), Cl.principal(user)]),
      callRead(pool, "get-bin-balances", [Cl.uint(uintKey)]),
    ]);
    const userShares = BigInt(balJ?.value?.value ?? balJ?.value ?? 0);
    const bv = binJ?.value?.value;
    if (userShares <= 0n || !bv) continue;
    const { x, y } = proratePosition(
      userShares,
      BigInt(bv["bin-shares"]?.value ?? 0),
      BigInt(bv["x-balance"]?.value ?? 0),
      BigInt(bv["y-balance"]?.value ?? 0),
    );
    bins.push({ signedBin: binSignedId(uintKey), userShares, userX: x, userY: y });
  }
  if (bins.length === 0) return empty;
  bins.sort((a, b) => a.signedBin - b.signedBin);
  return {
    pool: pool.key,
    user,
    bins,
    lowerSignedBin: bins[0].signedBin,
    upperSignedBin: bins[bins.length - 1].signedBin,
    totalX: bins.reduce((s, b) => s + b.userX, 0n),
    totalY: bins.reduce((s, b) => s + b.userY, 0n),
  };
}
