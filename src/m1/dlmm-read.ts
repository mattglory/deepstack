// DLMM read-only adapter (step 1 of the concentrated-liquidity build — POST-PILOT, reads only).
//
// The DLMM venue (deployer SM1FKXG..., core SP1PFR4V...dlmm-core-v-1-1) is a bin-based
// concentrated-liquidity DEX — the venue the aibtcdev agents market-make. This module READS
// its state: active bin, bin step, token pair, fee config, and local liquidity depth around
// the price. No capital, no writes, off the hot path, never throws — the same discipline as
// ststx-gap.ts. It is the safe foundation the eventual bin-aware position/rebalance layer
// builds on; the swap/mint write path (through the separate core) is deliberately NOT here yet.
//
// Verified on-chain 2026-07-24: get-pool-for-swap returns
//   { active-bin-id int, bin-step uint, core-address principal, initial-price uint,
//     x-token principal, y-token principal, protocol-fee/provider-fee/variable-fee uint, ... }
// get-bin-balances(id) returns { bin-shares uint, x-balance uint, y-balance uint }.

import { fetchCallReadOnlyFunction, cvToJSON, Cl } from "@stacks/transactions";
import { withRpc } from "./rpc.js";

const DEPLOYER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";

// The DLMM core stores bin balances in a UINT-keyed map but exposes the active bin as a SIGNED
// int relative to the pool's centre. Verified from the core source (SP1PFR4V…dlmm-core-v-1-1):
//   uint_key = signed_bin_id + CENTER_BIN_ID,  CENTER_BIN_ID = NUM_OF_BINS / 2 = 1001 / 2 = 500.
// EVERY bin read must convert signed→uint via +500 — including above-anchor pools. (An earlier
// version treated the signed id as a direct uint key and was silently reading dust bins ~450
// positions from the real position; this is the fix.) Valid bins are signed [-500, 500].
const CENTER_BIN_ID = 500;
const MAX_BIN_KEY = 1000; // NUM_OF_BINS - 1

/** Convert a signed bin id (as get-active-bin-id returns) to the uint key get-bin-balances wants. */
export function binUintKey(signedBinId: number): number {
  return signedBinId + CENTER_BIN_ID;
}

export interface DlmmPool {
  key: string; // short label
  name: string; // contract name under DEPLOYER
}

// The pools that matter to DeepStack (see the private venue map). stSTX-STX is the lowest-IL
// pair on Stacks; STX-USDCx is the haven-rotation destination; sBTC-USDCx is the clean-oracle
// stablecoin pair (the concentrated analog of the current sBTC-STX home).
export const DLMM_POOLS: readonly DlmmPool[] = [
  { key: "ststx-stx", name: "dlmm-pool-ststx-stx-v-1-bps-1" },
  { key: "stx-usdcx", name: "dlmm-pool-stx-usdcx-v-2-bps-10" },
  { key: "sbtc-usdcx", name: "dlmm-pool-sbtc-usdcx-v-1-bps-10" },
] as const;

export interface DlmmState {
  pool: string;
  activeBinId: number;
  binStep: number; // basis points between adjacent bins (1 = 0.01%)
  xToken: string;
  yToken: string;
  coreAddress: string;
  binChangeCount: number; // lifetime recenters — an activity signal
}

export interface DlmmDepth {
  activeBinId: number;
  halfWindow: number;
  xTotal: bigint; // summed raw x-balance across [active-half, active+half]
  yTotal: bigint; // summed raw y-balance across the window
  binsWithLiquidity: number;
  binsSkipped: number; // bins outside the pool's valid [-500, 500] signed range (edge only)
}

/**
 * Relative price multiplier of a bin vs bin 0 in a liquidity-book AMM: (1 + step)^binId.
 * Pure, for tests and later sizing. NOTE: this is a RATIO relative to bin 0 — the absolute
 * token price also needs the pool's `initial-price` anchor and both tokens' decimals, which
 * is deliberately deferred until verified against a reference price. Do not size trades on
 * this alone yet.
 */
export function binPriceMultiplier(binId: number, binStepBps: number): number {
  return Math.pow(1 + binStepBps / 1e4, binId);
}

/** Sum raw x/y balances across a bin window — pure, split out for tests. */
export function sumBinWindow(
  bins: Array<{ x: bigint; y: bigint } | null>,
): { xTotal: bigint; yTotal: bigint; binsWithLiquidity: number } {
  let xTotal = 0n;
  let yTotal = 0n;
  let binsWithLiquidity = 0;
  for (const b of bins) {
    if (!b) continue;
    if (b.x > 0n || b.y > 0n) binsWithLiquidity += 1;
    xTotal += b.x;
    yTotal += b.y;
  }
  return { xTotal, yTotal, binsWithLiquidity };
}

async function callRead(pool: DlmmPool, fn: string, args: any[] = []): Promise<any | null> {
  try {
    return cvToJSON(
      await withRpc((baseUrl) =>
        fetchCallReadOnlyFunction({
          contractAddress: DEPLOYER,
          contractName: pool.name,
          functionName: fn,
          functionArgs: args,
          network: "mainnet",
          client: { baseUrl },
          senderAddress: DEPLOYER,
        }),
      ),
    );
  } catch {
    return null;
  }
}

/** Read the pool's swap-facing state: active bin, step, tokens, core, and activity. */
export async function readDlmmState(pool: DlmmPool): Promise<DlmmState | null> {
  const j = await callRead(pool, "get-pool-for-swap", [Cl.bool(true)]);
  const t = j?.value?.value;
  if (!t) return null;
  const fees = await callRead(pool, "get-variable-fees-data");
  const changeCount = Number(fees?.value?.value?.["bin-change-count"]?.value ?? 0);
  return {
    pool: pool.key,
    activeBinId: Number(t["active-bin-id"]?.value),
    binStep: Number(t["bin-step"]?.value),
    xToken: String(t["x-token"]?.value ?? ""),
    yToken: String(t["y-token"]?.value ?? ""),
    coreAddress: String(t["core-address"]?.value ?? ""),
    binChangeCount: changeCount,
  };
}

/** Sum liquidity across a window of bins centred on the active bin. */
export async function readLocalDepth(pool: DlmmPool, activeBinId: number, halfWindow = 10): Promise<DlmmDepth> {
  const bins: Array<{ x: bigint; y: bigint } | null> = [];
  let binsSkipped = 0;
  for (let signedId = activeBinId - halfWindow; signedId <= activeBinId + halfWindow; signedId++) {
    const key = binUintKey(signedId);
    if (key < 0 || key > MAX_BIN_KEY) {
      // Outside the pool's 1001-bin range (signed [-500, 500]) — no such bin exists.
      binsSkipped += 1;
      bins.push(null);
      continue;
    }
    const j = await callRead(pool, "get-bin-balances", [Cl.uint(key)]);
    const v = j?.value?.value;
    if (!v) {
      bins.push(null);
      continue;
    }
    bins.push({ x: BigInt(v["x-balance"]?.value ?? 0), y: BigInt(v["y-balance"]?.value ?? 0) });
  }
  const { xTotal, yTotal, binsWithLiquidity } = sumBinWindow(bins);
  return { activeBinId, halfWindow, xTotal, yTotal, binsWithLiquidity, binsSkipped };
}

export interface DlmmScanRow {
  pool: string;
  state: DlmmState | null;
  depth: DlmmDepth | null;
}

/** Read state + local depth for every target pool. Never throws; nulls where a read failed. */
export async function scanDlmm(halfWindow = 10): Promise<DlmmScanRow[]> {
  const out: DlmmScanRow[] = [];
  for (const pool of DLMM_POOLS) {
    const state = await readDlmmState(pool);
    const depth = state ? await readLocalDepth(pool, state.activeBinId, halfWindow) : null;
    out.push({ pool: pool.key, state, depth });
  }
  return out;
}
