// Fees actually earned by the concentrated (DLMM) position, measured from chain data.
//
// Why: Bitflow's and BFF.army's "earnings" disagreed tenfold on the same day (2026-10-30: $5.32 vs
// $52.65). BFF applies the pool-wide fee/TVL ratio to our position value, which assumes we hold the
// pool's average share of the bins where trading happens; spread across 101 bins we hold far less
// there. We need our own number.
//
// Method: inside one bin every swap trades x for y at that bin's fixed price p, so a bin's value at
// its own price, x·p + y, does not change with trading. Only the fees paid into the bin raise it.
// So, per bin we hold, fees = (x_now·p + y_now) − (x_deposited·p + y_deposited), summed in y. It
// needs the per-bin amounts we deposited, recorded from each add transaction's own arguments, and
// each bin's price (fixed, read once when the deposit is recorded).
//
// Known small bias: an add into the active bin can pay a liquidity fee to the bin, which counts in
// the deposit here, so fees read very slightly low. Never high.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DepositBin { bin: number; x: bigint; y: bigint; price: bigint } // base units; price = y per x × 1e8
export interface DlmmDeposit { pool: string; owner: string; t: string; txids: string[]; bins: DepositBin[] }
export interface HeldBin { signedBin: number; userX: bigint; userY: bigint }

const SCALE = 100_000_000n;
const valueAtBinPrice = (x: bigint, y: bigint, price: bigint) => (x * price) / SCALE + y;

/** Per-bin amounts from an add-liquidity-multi call's first argument (its Clarity repr). */
export function parseAddLiquidityRepr(repr: string): { bin: number; x: bigint; y: bigint }[] {
  const out: { bin: number; x: bigint; y: bigint }[] = [];
  for (const m of repr.matchAll(/\(tuple ([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const t = m[1];
    const bin = /\(bin-id (-?\d+)\)/.exec(t)?.[1];
    const x = /\(x-amount u(\d+)\)/.exec(t)?.[1];
    const y = /\(y-amount u(\d+)\)/.exec(t)?.[1];
    if (bin != null && x != null && y != null) out.push({ bin: Number(bin), x: BigInt(x), y: BigInt(y) });
  }
  return out;
}

/** Adds an add's bins to the record (a top-up of the same bins accumulates). */
export function mergeDeposit(prev: DlmmDeposit | null, add: { pool: string; owner: string; t: string; txid: string; bins: DepositBin[] }): DlmmDeposit {
  const same = prev && prev.pool === add.pool && prev.owner === add.owner ? prev : null;
  const byBin = new Map<number, DepositBin>((same?.bins ?? []).map((b) => [b.bin, { ...b }]));
  for (const b of add.bins) {
    const cur = byBin.get(b.bin);
    byBin.set(b.bin, cur ? { ...cur, x: cur.x + b.x, y: cur.y + b.y } : { ...b });
  }
  return {
    pool: add.pool, owner: add.owner, t: same?.t ?? add.t,
    txids: [...(same?.txids ?? []), add.txid],
    bins: [...byBin.values()].sort((a, b) => a.bin - b.bin),
  };
}

/**
 * Fees earned (y base units) by the bins we still hold that the record covers. null when the
 * record does not describe this position (no overlap: a stale record), so a wrong number is never
 * shown.
 */
export function feesEarned(dep: DlmmDeposit, held: HeldBin[]): { feesY: bigint; depositY: bigint; nowY: bigint; bins: number } | null {
  const byBin = new Map(dep.bins.map((b) => [b.bin, b]));
  let depositY = 0n, nowY = 0n, bins = 0;
  for (const h of held) {
    const d = byBin.get(h.signedBin);
    if (!d) continue;
    depositY += valueAtBinPrice(d.x, d.y, d.price);
    nowY += valueAtBinPrice(h.userX, h.userY, d.price);
    bins++;
  }
  if (bins === 0) return null;
  return { feesY: nowY - depositY, depositY, nowY, bins };
}

// ---- the record on disk (journal/ survives deploys) ----

export function depositPath(): string {
  return process.env.DLMM_DEPOSIT_PATH ?? "journal/dlmm-deposit.json";
}

export function loadDeposit(path = depositPath()): DlmmDeposit | null {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8"));
    return {
      pool: String(j.pool), owner: String(j.owner), t: String(j.t), txids: (j.txids ?? []).map(String),
      bins: (j.bins ?? []).map((b: { bin: number; x: string; y: string; price: string }) => ({ bin: Number(b.bin), x: BigInt(b.x), y: BigInt(b.y), price: BigInt(b.price) })),
    };
  } catch {
    return null;
  }
}

export function saveDeposit(d: DlmmDeposit, path = depositPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...d, bins: d.bins.map((b) => ({ bin: b.bin, x: b.x.toString(), y: b.y.toString(), price: b.price.toString() })) }, null, 2));
  renameSync(tmp, path);
}

export function clearDeposit(path = depositPath()): void {
  rmSync(path, { force: true });
}
