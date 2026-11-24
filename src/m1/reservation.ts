// Per-venue token reservation (docs/WALLET_RESERVATION_DESIGN.md), stage 1: SHADOW ONLY.
//
// The XYK step, the DLMM and (later) capital-preservation mode trade from one wallet, and nothing
// records which loose tokens belong to which venue (the 2026-11-14/15 incident). Each venue declares
// a claim derived from the state it already persists; a venue may spend only
//   wallet - gas reserve - the OTHER venues' claims.
// This module computes that. In stage 1 the agent only LOGS the result next to what each step
// actually used (agent-cli `reservation-shadow`); nothing is enforced and no trade changes.

/** An asset key as in post-conditions.ts: "STX" for native STX, else "<contract>::<asset>". */
export type AssetKey = string;
export const STX: AssetKey = "STX";

export type Venue = "xyk" | "dlmm" | "trend";

export interface Claim {
  venue: Venue;
  asset: AssetKey;
  amount: bigint; // base units
  source: string; // where the claim comes from (a state file), for the journal
}

export interface Allocation {
  /** What each venue may spend, per asset (base units, never negative). */
  available: Record<Venue, Record<AssetKey, bigint>>;
  /** Over-claims beyond the dust tolerance, and unreadable claim sources: each needs a human. */
  problems: string[];
}

/** Dust tolerance for indexer lag: claims may exceed the balance by max(bps of the balance, units). */
export interface Tolerance {
  bps: number;
  units: bigint;
}
export const DEFAULT_TOLERANCE: Tolerance = { bps: 50, units: 1n };

const VENUES: Venue[] = ["xyk", "dlmm", "trend"];

/**
 * Split the wallet between venues. The XYK is the residual owner: it gets whatever no other venue
 * claims. A claimant venue gets its own claim (capped at what is actually there). Pure.
 */
export function allocate(
  wallet: Record<AssetKey, bigint>,
  claims: Claim[],
  gasReserve: Record<AssetKey, bigint>,
  unreadable: string[] = [],
  tol: Tolerance = DEFAULT_TOLERANCE,
): Allocation {
  const problems = unreadable.map((s) => `claim source unreadable: ${s} (its venue's tokens are unknown; nothing else may spend them)`);
  const assets = new Set<AssetKey>([...Object.keys(wallet), ...claims.map((c) => c.asset)]);
  const available = Object.fromEntries(VENUES.map((v) => [v, {} as Record<AssetKey, bigint>])) as Allocation["available"];
  for (const asset of assets) {
    const bal = wallet[asset] ?? 0n;
    const gas = gasReserve[asset] ?? 0n;
    const usable = bal > gas ? bal - gas : 0n;
    const claimed = (v: Venue) => claims.filter((c) => c.venue === v && c.asset === asset).reduce((s, c) => s + c.amount, 0n);
    const totalClaims = VENUES.filter((v) => v !== "xyk").reduce((s, v) => s + claimed(v), 0n);
    const slack = ((usable * BigInt(tol.bps)) / 10_000n > tol.units ? (usable * BigInt(tol.bps)) / 10_000n : tol.units);
    if (totalClaims > usable + slack) {
      problems.push(`over-claim on ${asset}: claims ${totalClaims} > usable ${usable} (balance ${bal} - gas ${gas})`);
      // Design rule 2: nothing trades this token this cycle. Capping each claimant at `usable`
      // instead would let two claimants each spend the whole balance (review R101-1).
      for (const v of VENUES) available[v][asset] = 0n;
      continue;
    }
    for (const v of VENUES) {
      if (v === "xyk") available.xyk[asset] = usable > totalClaims ? usable - totalClaims : 0n;
      else {
        const c = claimed(v);
        available[v][asset] = c < usable ? c : usable;
      }
    }
  }
  // Fail closed: an unreadable source means unknown claims, so the residual owner (XYK) gets nothing.
  if (unreadable.length) for (const a of Object.keys(available.xyk)) available.xyk[a] = 0n;
  return { available, problems };
}

/** The DLMM's claim from a pending re-add: exactly its recorded x and y, on the pool's pinned tokens. */
export function pendingReaddClaims(
  pending: { pair: string; xBase: bigint; yBase: bigint } | null,
  pin: { xToken: string; xAsset: string; yToken: string; yAsset: string } | undefined,
  source: string,
): Claim[] {
  if (!pending || !pin) return [];
  const key = (token: string, asset: string): AssetKey => (asset === "" ? STX : `${token}::${asset}`);
  const claims: Claim[] = [
    { venue: "dlmm", asset: key(pin.xToken, pin.xAsset), amount: pending.xBase, source },
    { venue: "dlmm", asset: key(pin.yToken, pin.yAsset), amount: pending.yBase, source },
  ];
  return claims.filter((c) => c.amount > 0n);
}
