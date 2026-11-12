// Value of the extra DLMM pairs' positions (dlmm-pairs.ts), in STX, for portfolioY and the
// samples' dlmmPairs. The primary pair is still valued by agent-cli.ts's dlmmPositionValueY.
//
// Same rules as the primary's valuation: values only pinned pools (pinMismatch), and on a read
// failure reuses the pair's last good value (seeded from disk after a restart) rather than 0, so
// a Hiro hiccup can never look like capital vanishing and trip the drawdown gate. A reused value
// carries no activeBin, so a stale bin never enters the pair's vol series.
//
// Free balances: only tokens nobody else counts. The XYK side already counts free sBTC and STX,
// and the primary pair its own y-token (USDCx), so a STX/sBTC extra pair adds no free balance.

import type { Wallet } from "./wallet.js";
import { DLMM_POOLS, readDlmmState, pinMismatch } from "./dlmm-read.js";
import { readUserPosition } from "./dlmm-position.js";
import { resolveToken, ftBalance, type TokenMeta } from "./dlmm-recenter-exec.js";
import { loadDeposit, feesEarned, depositPath } from "./dlmm-fees.js";
import { loadHistory, type DlmmPairSample } from "./metrics.js";
import { briefError } from "./supervise.js";

const SBTC = /sbtc/i;
const STABLE = /usdc|usdh|usda|susd/i;

/**
 * STX per one whole unit of `tok`, or null if there is no mapping. midSbtcInStx is the XYK mid
 * (STX per sBTC); usdPerStx the STX price in USD. Pure.
 */
export function stxPerUnit(tok: { native: boolean; principal: string; asset: string }, midSbtcInStx: number, usdPerStx: number): number | null {
  if (tok.native || /token-stx/.test(tok.principal)) return 1;
  if (SBTC.test(tok.asset) || SBTC.test(tok.principal)) return midSbtcInStx > 0 ? midSbtcInStx : null;
  if (STABLE.test(tok.asset)) return usdPerStx > 0 ? 1 / usdPerStx : null;
  return null;
}

/** Whether a free balance of `tok` is already counted elsewhere (XYK sBTC/STX, or `countedAssets`). Pure. */
export function freeBalanceCounted(tok: { native: boolean; principal: string; asset: string }, countedAssets: string[]): boolean {
  if (tok.native || /token-stx/.test(tok.principal)) return true;
  if (SBTC.test(tok.asset) || SBTC.test(tok.principal)) return true;
  return countedAssets.includes(`${tok.principal}::${tok.asset}`);
}

const last = new Map<string, DlmmPairSample>();
let seeded = false;
function seedFromDisk(): void {
  if (seeded) return;
  seeded = true;
  const hist = loadHistory();
  for (let i = hist.length - 1; i >= 0 && hist[i]; i--) {
    for (const [pair, ps] of Object.entries(hist[i].dlmmPairs ?? {})) if (!last.has(pair)) last.set(pair, { valueY: ps.valueY });
    if (last.size) return;
  }
}

export interface ExtraPairsValue {
  totalValueY: number; // positions plus any free balance not counted elsewhere
  freeValueY: number;
  pairs: Record<string, DlmmPairSample>;
}

export async function extraPairsValueY(
  w: Wallet, pairs: string[], midSbtcInStx: number, usdPerStx: number, countedAssets: string[],
  log: (s: string) => void = console.warn,
): Promise<ExtraPairsValue> {
  const out: ExtraPairsValue = { totalValueY: 0, freeValueY: 0, pairs: {} };
  if (!pairs.length) return out;
  seedFromDisk();
  const freeSeen = new Set<string>();
  for (const pair of pairs) {
    const reuse = () => {
      const l = last.get(pair);
      if (l) { out.pairs[pair] = { valueY: l.valueY }; out.totalValueY += l.valueY; }
    };
    try {
      const poolDef = DLMM_POOLS.find((p) => p.key === pair);
      if (!poolDef) throw new Error(`unknown pool ${pair}`);
      const st = await readDlmmState(poolDef);
      if (!st) { reuse(); continue; }
      const [xTok, yTok] = await Promise.all([resolveToken(st.xToken), resolveToken(st.yToken)]);
      const mismatch = pinMismatch(poolDef, st, xTok, yTok);
      if (mismatch) {
        log(`  [dlmm-value ${pair}] ⛔ pool does not match its pinned definition (${mismatch}) — reusing its last value`);
        reuse();
        continue;
      }
      const px = stxPerUnit(xTok, midSbtcInStx, usdPerStx), py = stxPerUnit(yTok, midSbtcInStx, usdPerStx);
      if (px === null || py === null) { log(`  [dlmm-value ${pair}] no STX price for its tokens — reusing its last value`); reuse(); continue; }
      const pos = await readUserPosition(poolDef, w.address);
      const valueY = (Number(pos.totalX) / 10 ** xTok.decimals) * px + (Number(pos.totalY) / 10 ** yTok.decimals) * py;
      const sample: DlmmPairSample = { valueY, activeBin: st.activeBinId, binStep: st.binStep };
      const dep = loadDeposit(depositPath(pair));
      if (dep && dep.pool === pair && dep.owner === w.address) {
        const f = feesEarned(dep, pos.bins);
        if (f) {
          const feesY = Number(f.feesY) / 10 ** yTok.decimals;
          Object.assign(sample, { feesY: +feesY.toFixed(yTok.decimals), feesValueY: +(feesY * py).toFixed(4), feesSince: dep.t });
        }
      }
      out.pairs[pair] = sample;
      out.totalValueY += valueY;
      last.set(pair, { valueY });
      for (const tok of [xTok, yTok] as TokenMeta[]) {
        const id = `${tok.principal}::${tok.asset}`;
        if (freeBalanceCounted(tok, countedAssets) || freeSeen.has(id)) continue;
        freeSeen.add(id);
        try {
          const free = (Number(await ftBalance(w.address, id)) / 10 ** tok.decimals) * stxPerUnit(tok, midSbtcInStx, usdPerStx)!;
          out.freeValueY += free;
          out.totalValueY += free;
        } catch (err) {
          log(`  [dlmm-value ${pair}] free ${tok.asset} balance unreadable this tick: ${briefError((err as Error).message)}`);
        }
      }
    } catch (err) {
      log(`  [dlmm-value ${pair}] read failed, reusing its last value: ${briefError((err as Error).message)}`);
      reuse();
    }
  }
  return out;
}
