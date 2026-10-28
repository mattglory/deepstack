// The pending re-add of a recenter whose rebalance didn't finish (see nextReaddStep in
// dlmm-recenter.ts). Persisted so a restart, or the next cycle, resumes it instead of re-adding
// from whatever the wallet holds. Same pattern as dlmm-failstreak-state.ts.
//
// Config: DLMM_PENDING_STATE_PATH, default journal/dlmm-pending-readd.json (journal/ survives
// deploys). Deleting the file abandons the pending re-add; the tokens stay in the wallet.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PendingReadd {
  pair: string;
  xBase: bigint; // withdrawn X still to re-add (after swaps so far)
  yBase: bigint;
  before: { x: number; y: number }; // position legs before the withdraw, for the basis adjustment
  t: string; // when the withdraw confirmed
  abortedSwaps: number; // consecutive swaps that failed on-chain; stops retrying at the limit
  // A rebalance swap broadcast but not yet confirmed when the cycle moved on. Checked before the
  // next step, so a late confirmation is applied to the amounts rather than planned around
  // (review 2026-10-28, point 3).
  pendingSwap?: { txid: string; direction: "x-for-y" | "y-for-x" };
}

export function pendingStatePath(): string {
  return process.env.DLMM_PENDING_STATE_PATH ?? "journal/dlmm-pending-readd.json";
}

export function loadPending(path = pendingStatePath()): PendingReadd | null {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (typeof j?.pair !== "string") return null;
    return {
      pair: j.pair, xBase: BigInt(j.xBase), yBase: BigInt(j.yBase),
      before: { x: Number(j.before?.x ?? 0), y: Number(j.before?.y ?? 0) },
      t: String(j.t), abortedSwaps: Number(j.abortedSwaps ?? 0),
      ...(j.pendingSwap?.txid ? { pendingSwap: { txid: String(j.pendingSwap.txid), direction: j.pendingSwap.direction === "y-for-x" ? "y-for-x" : "x-for-y" } } : {}),
    };
  } catch {
    return null;
  }
}

export function savePending(p: PendingReadd, path = pendingStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...p, xBase: p.xBase.toString(), yBase: p.yBase.toString() }, null, 2));
  renameSync(tmp, path);
}

export function clearPending(path = pendingStatePath()): void {
  rmSync(path, { force: true });
}
