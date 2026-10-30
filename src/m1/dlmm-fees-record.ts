// Records what a confirmed add-liquidity transaction deposited, per bin, for dlmm-fees.ts.
// Read from the transaction's own arguments on chain, so the record is exactly what was sent.
// Never throws to the caller: a missing record only means no fee figure, never a wrong trade.

import { withRpc, hiroFetch } from "./rpc.js";
import { DLMM_POOLS, readDlmmState, readBinPrices } from "./dlmm-read.js";
import { parseAddLiquidityRepr, mergeDeposit, loadDeposit, saveDeposit } from "./dlmm-fees.js";

interface TxJson {
  tx_status?: string;
  sender_address?: string;
  burn_block_time_iso?: string;
  contract_call?: { function_name?: string; function_args?: { repr: string }[] };
}

export async function recordDepositFromTx(txid: string, owner: string, poolKey: string, log: (s: string) => void = () => {}): Promise<boolean> {
  try {
    const poolDef = DLMM_POOLS.find((p) => p.key === poolKey);
    if (!poolDef) throw new Error(`unknown pool ${poolKey}`);
    const j = await withRpc((baseUrl) =>
      hiroFetch(baseUrl)(`${baseUrl}/extended/v1/tx/${txid}`).then((r) => {
        if (!r.ok) throw new Error(`tx read failed: ${r.status}`);
        return r.json() as Promise<TxJson>;
      }),
    );
    if (j.tx_status !== "success") throw new Error(`tx ${txid} is ${j.tx_status}`);
    if (j.sender_address !== owner) throw new Error(`tx ${txid} was not sent by ${owner}`);
    if (!j.contract_call?.function_name?.startsWith("add-liquidity")) throw new Error(`tx ${txid} is not an add-liquidity call`);
    const repr = j.contract_call.function_args?.[0]?.repr ?? "";
    if (!repr.includes(`.${poolDef.name})`)) throw new Error(`tx ${txid} is not for ${poolDef.name}`);
    const amounts = parseAddLiquidityRepr(repr);
    if (amounts.length === 0) throw new Error(`no bins found in tx ${txid}`);
    const st = await readDlmmState(poolDef);
    if (!st) throw new Error("pool state unreadable");
    const prices = await readBinPrices(st.coreAddress, st.initialPrice, st.binStep, amounts.map((a) => a.bin));
    const next = mergeDeposit(loadDeposit(), {
      pool: poolKey, owner, t: j.burn_block_time_iso ?? new Date().toISOString(), txid,
      bins: amounts.map((a) => ({ ...a, price: prices.get(a.bin)! })),
    });
    saveDeposit(next);
    log(`  [dlmm-fees] recorded the deposit in ${amounts.length} bins from ${txid.slice(0, 10)}`);
    return true;
  } catch (err) {
    log(`  [dlmm-fees] deposit not recorded (${(err as Error).message}); fees will not be shown until it is (m1:dlmm-fees -- seed <txid>)`);
    return false;
  }
}
