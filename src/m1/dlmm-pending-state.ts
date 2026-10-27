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
