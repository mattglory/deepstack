// Scanner v2 — the stSTX cross-pool gap, measured the only way that's real: by quoting
// the actual round trip on-chain, both directions, every cycle.
//
// The Bitflow ticker reports price=0 for these pools, so the gap is invisible off-chain.
// But get-dy / get-dx quotes are NET of each pool's fee — so chaining them (STX → stSTX
// on pool A, stSTX → STX on pool B) yields the true gross profit of the atomic arb the
// crosspool-ststx-receiver (FlashStack side, checked draft) would execute. Subtract the
// flash fee and gas and the journalled number IS the arm decision: positive = capturable.
//
// Read-only, off the hot path, never throws. The deploy/no-deploy decision for the
// receiver is made by this series — a week-plus of data before any capital moves.

import { fetchCallReadOnlyFunction, cvToJSON, Cl } from "@stacks/transactions";
import { withRpc } from "./rpc.js";

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
          client: { baseUrl },
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

/** Quote the atomic round trip in both directions at the receiver's cap size. */
export async function scanStstxGap(probeStx = 100): Promise<GapObs[]> {
  const probeU = BigInt(Math.round(probeStx * 1e6));
  const out: GapObs[] = [];
  for (const [a, b] of [[POOLS[0], POOLS[1]], [POOLS[1], POOLS[0]]] as const) {
    const ststx = await readUint(a, "get-dy", probeU); // STX → stSTX in pool a
    if (ststx === null || ststx === 0n) continue;
    const back = await readUint(b, "get-dx", ststx); // stSTX → STX in pool b
    if (back === null) continue;
    const m = gapMetrics(Number(probeU), Number(back));
    out.push({ dir: `${a.key}→${b.key}`, probeStx, stxBack: +(Number(back) / 1e6).toFixed(4), ...m });
  }
  return out;
}
