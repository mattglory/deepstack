// The owner's reservation claim (docs/WALLET_RESERVATION_DESIGN.md section 2, review answer 4): capital
// the owner hasn't allocated to a venue yet. Nothing trades it until an attended command allocates it.
//
// Two sources:
//  - recorded owner deposits (capital-flows.json) without an `allocated` marker. The 2026-10-27
//    deposits went into the DLMM and are marked `allocated: "dlmm"` by `m1:flow -- allocate`.
//  - owner holds (journal/owner-holds.json): tokens the owner set aside by hand, for example what an
//    attended DLMM wind-down withdrew (2026-11-24: 0.0197589 sBTC + 1,198.06 USDCx). Without a hold
//    they would be unclaimed, and the XYK, the residual owner, would trade them.
// Files that exist but can't be read are reported as unreadable, so the reservation fails closed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Claim } from "./reservation.js";
import { STX } from "./reservation.js";

export interface OwnerHold { id: string; t: string; asset: string; amount: string; note?: string }

export function ownerHoldsPath(): string {
  return process.env.OWNER_HOLDS_PATH ?? "journal/owner-holds.json";
}
function flowsPath(): string {
  return process.env.CAPITAL_FLOWS_PATH ?? "journal/capital-flows.json";
}

type Load<T> = { ok: true; value: T } | { ok: false; reason: string };

function strictArray<T>(path: string, valid: (x: any) => boolean): Load<T[]> {
  if (!existsSync(path)) return { ok: true, value: [] };
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(v) || !v.every(valid)) return { ok: false, reason: `${path}: invalid contents` };
    return { ok: true, value: v as T[] };
  } catch (e) {
    return { ok: false, reason: `${path}: ${(e as Error).message}` };
  }
}

export function loadOwnerHolds(path = ownerHoldsPath()): Load<OwnerHold[]> {
  return strictArray<OwnerHold>(path, (h) => typeof h?.id === "string" && typeof h?.asset === "string" && /^\d+$/.test(h?.amount ?? ""));
}

export function saveOwnerHolds(holds: OwnerHold[], path = ownerHoldsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(holds, null, 2));
  renameSync(tmp, path);
}

/** Pure: the owner's claims from the flows and the holds. */
export function ownerClaims(
  flows: { txid: string; stx: number; allocated?: string }[],
  holds: OwnerHold[],
  sources: { flows: string; holds: string },
): Claim[] {
  const claims: Claim[] = [];
  for (const f of flows) {
    if (f.stx > 0 && !f.allocated) claims.push({ venue: "owner", asset: STX, amount: BigInt(Math.round(f.stx * 1e6)), source: `${sources.flows} ${f.txid}` });
  }
  for (const h of holds) {
    const amount = BigInt(h.amount);
    if (amount > 0n) claims.push({ venue: "owner", asset: h.asset, amount, source: `${sources.holds} ${h.id}` });
  }
  return claims;
}

/** The owner's claims as the agent reads them each cycle, and any unreadable source. */
export function readOwnerClaims(): { claims: Claim[]; unreadable: string[] } {
  const fp = flowsPath(), hp = ownerHoldsPath();
  const flows = strictArray<{ txid: string; stx: number; allocated?: string }>(fp, (f) => typeof f?.txid === "string" && typeof f?.stx === "number");
  const holds = loadOwnerHolds(hp);
  const unreadable = [!flows.ok && flows.reason, !holds.ok && holds.reason].filter(Boolean) as string[];
  return { claims: ownerClaims(flows.ok ? flows.value : [], holds.ok ? holds.value : [], { flows: fp, holds: hp }), unreadable };
}
