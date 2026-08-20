// Scanner v2 — the stSTX cross-pool gap, measured the only way that's real: by quoting
// the actual round trip on-chain, both directions, every cycle.
//
// The Bitflow ticker reports price=0 for these pools, so the gap is invisible off-chain.
// But get-dy / get-dx quotes are NET of each pool's fee — so chaining them (STX → stSTX
// on pool A, stSTX → STX on pool B) yields the gross profit the atomic arb the
// crosspool-ststx-receiver (FlashStack side, checked draft) would execute.
//
// BUT a quote is not a fill: get-dy/get-dx compute even on a pool whose swaps are
// disabled. A pool can be de-listed — admin sets its pair unapproved — and keep returning
// a rosy quote while every real swap aborts with err-pair-not-approved. That is exactly
// v-1-1's state as of 2026-08 (approval=false; its last swap aborted, only withdrawals
// since). So each observation also carries `executable`, true only when BOTH legs' pairs
// are approved. A positive netStx with executable=false is a phantom, not an opportunity.
//
// Read-only, off the hot path, never throws. The deploy/no-deploy decision for the
// receiver is made by this series — a week-plus of data before any capital moves.

import { fetchCallReadOnlyFunction, cvToJSON, Cl } from "@stacks/transactions";
import { withRpc, hiroFetch } from "./rpc.js";

const DEPLOYER = "SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M";
const STSTX = { address: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG", name: "ststx-token" };
const POOLS = [
  { key: "v-1-1", name: "stableswap-stx-ststx-v-1-1", lp: "stx-ststx-lp-token-v-1-1" },
  { key: "v-1-2", name: "stableswap-stx-ststx-v-1-2", lp: "stx-ststx-lp-token-v-1-2" },
] as const;

const FLASH_FEE_BPS = 5;
const GAS_USTX = 100_000; // arm + flash-loan txs at 0.05 STX each

export interface GapObs {
  dir: string; // "v-1-1→v-1-2" = buy stSTX in v-1-1, sell in v-1-2
  probeStx: number;
  stxBack: number;
  grossBps: number; // round trip vs probe, pool fees already inside the quotes
  netStx: number; // after flash fee + gas — positive means the atomic arb pays
  executable: boolean; // both legs' pairs approved; false => quote is a phantom, swaps abort
}

/** An arb is only real if BOTH legs can actually swap. Pure, for tests. */
export function bothApproved(buyLegApproved: boolean, sellLegApproved: boolean): boolean {
  return buyLegApproved && sellLegApproved;
}

/** Pure math split out for tests. */
export function gapMetrics(probeU: number, backU: number): { grossBps: number; netStx: number } {
  const flashFee = Math.max(1, Math.floor((probeU * FLASH_FEE_BPS) / 10_000));
  const grossBps = ((backU - probeU) / probeU) * 10_000;
  const netStx = (backU - probeU - flashFee - GAS_USTX) / 1e6;
  return { grossBps: +grossBps.toFixed(1), netStx: +netStx.toFixed(4) };
}

async function readUint(pool: (typeof POOLS)[number], fn: string, amount: bigint): Promise<bigint | null> {
  try {
    const j = cvToJSON(
      await withRpc((baseUrl) =>
        fetchCallReadOnlyFunction({
          contractAddress: DEPLOYER,
          contractName: pool.name,
          functionName: fn,
          functionArgs: [
            Cl.contractPrincipal(STSTX.address, STSTX.name),
            Cl.contractPrincipal(DEPLOYER, pool.lp),
            Cl.uint(amount),
          ],
          network: "mainnet",
          client: { baseUrl, fetch: hiroFetch(baseUrl) },
          senderAddress: DEPLOYER,
        }),
      ),
    ) as any;
    const v = j?.value?.value ?? j?.value;
    return v !== undefined ? BigInt(v) : null;
  } catch {
    return null;
  }
}

/**
 * Is this pool's pair approved for swapping? get-pair-data(...).approval — the same gate
 * that makes a real swap abort with err-pair-not-approved when false. Fail-closed: if the
 * flag can't be read, treat the pair as NOT executable rather than assume it trades.
 */
async function pairApproved(pool: (typeof POOLS)[number]): Promise<boolean> {
  try {
    const j = cvToJSON(
      await withRpc((baseUrl) =>
        fetchCallReadOnlyFunction({
          contractAddress: DEPLOYER,
          contractName: pool.name,
          functionName: "get-pair-data",
          functionArgs: [
            Cl.contractPrincipal(STSTX.address, STSTX.name),
            Cl.contractPrincipal(DEPLOYER, pool.lp),
          ],
          network: "mainnet",
          client: { baseUrl, fetch: hiroFetch(baseUrl) },
          senderAddress: DEPLOYER,
        }),
      ),
    ) as any;
    return (j?.value?.value?.approval?.value ?? j?.value?.approval?.value) === true;
  } catch {
    return false;
  }
}

/** Quote the atomic round trip in both directions at the receiver's cap size. */
export async function scanStstxGap(probeStx = 100): Promise<GapObs[]> {
  const probeU = BigInt(Math.round(probeStx * 1e6));
  // Approval is a property of each pool, not of direction — read once, reuse both ways.
  const approved = new Map<string, boolean>();
  for (const p of POOLS) approved.set(p.key, await pairApproved(p));
  const out: GapObs[] = [];
  for (const [a, b] of [[POOLS[0], POOLS[1]], [POOLS[1], POOLS[0]]] as const) {
    const ststx = await readUint(a, "get-dy", probeU); // STX → stSTX in pool a
    if (ststx === null || ststx === 0n) continue;
    const back = await readUint(b, "get-dx", ststx); // stSTX → STX in pool b
    if (back === null) continue;
    const m = gapMetrics(Number(probeU), Number(back));
    const executable = bothApproved(approved.get(a.key) ?? false, approved.get(b.key) ?? false);
    out.push({ dir: `${a.key}→${b.key}`, probeStx, stxBack: +(Number(back) / 1e6).toFixed(4), ...m, executable });
  }
  return out;
}
