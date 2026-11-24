// Guards for the DLMM valuation in agent-cli's readMarket (pure, unit-tested).
//
// 2026-11-21 05:56 UTC: thirty minutes after a confirmed re-add (05:25), one cycle's reads came back
// from before it. The position read was EMPTY and the free USDCx still held the deposited USDCx,
// while the free sBTC read was already after it. The deposited sBTC was counted nowhere: the
// portfolio read 10,696 STX instead of about 16,000, and the drawdown halt fired on a 29% "loss"
// that didn't exist. The next cycle read correctly. No read threw, so the existing "read failed,
// reuse last known values" path never ran, and that cache held the pending period's DLMM value of 0.
//
// Two fixes:
//  1. An empty position while the agent's own deposit record (written from the confirmed add
//     transaction) says it holds one is a stale read, handled like a failed read. If it is still
//     empty after STALE_EMPTY_LIMIT cycles in a row it is accepted, with a warning: the record may be
//     out of date (e.g. a withdrawal made outside the agent).
//  2. After the agent's own confirmed add, the reuse cache is set from the deposit record, so a
//     stale or failed read right after it reuses the new position, not the pending period's 0.

import type { DlmmDeposit } from "./dlmm-fees.js";

export const STALE_EMPTY_LIMIT = 3;

export interface StaleCheck {
  stale: boolean; // treat this read as failed and reuse the last known values
  streak: number; // consecutive empty reads against a deposit record
  warn: string | null;
}

export function checkEmptyPosition(
  positionBins: number,
  deposit: DlmmDeposit | null,
  pool: string,
  owner: string,
  streak: number,
  limit = STALE_EMPTY_LIMIT,
): StaleCheck {
  const recorded = !!deposit && deposit.pool === pool && deposit.owner === owner && deposit.bins.length > 0;
  if (positionBins > 0 || !recorded) return { stale: false, streak: 0, warn: null };
  const next = streak + 1;
  if (next >= limit) {
    return { stale: false, streak: next, warn: `position read empty ${next} cycles in a row although the deposit record (${deposit!.t}) says one exists; accepting it. Check the record.` };
  }
  return { stale: true, streak: next, warn: `position read empty right after/while a recorded deposit (${deposit!.t}) exists; treating it as a stale read (${next}/${limit})` };
}

/**
 * The reuse cache after the agent's own confirmed add: the deposit valued at the current prices
 * (x at `midXinY`, the USDCx leg at `usdPerStx`), and the free USDCx reduced by what went in.
 * Values in the agent's y unit (STX). null when there is nothing usable.
 */
export function cacheAfterDeposit(
  deposit: DlmmDeposit | null,
  xDecimals: number,
  yDecimals: number,
  midXinY: number,
  usdPerStx: number,
  lastFreeUsdcxValueY: number,
): { dlmmValueY: number; freeUsdcxValueY: number } | null {
  if (!deposit || deposit.bins.length === 0 || !(midXinY > 0) || !(usdPerStx > 0)) return null;
  const x = deposit.bins.reduce((s, b) => s + b.x, 0n);
  const y = deposit.bins.reduce((s, b) => s + b.y, 0n);
  const yValueY = Number(y) / 10 ** yDecimals / usdPerStx;
  return {
    dlmmValueY: (Number(x) / 10 ** xDecimals) * midXinY + yValueY,
    freeUsdcxValueY: Math.max(0, lastFreeUsdcxValueY - yValueY),
  };
}
