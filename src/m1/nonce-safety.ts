// Nonce-gap / pending-tx safety — refuse to broadcast when a prior transaction from this
// wallet hasn't confirmed yet. @stacks/transactions' fetchNonce (used throughout actions.ts
// and dlmm-recenter-exec.ts) only reads the last CONFIRMED nonce; it has no idea whether a
// broadcast using that nonce is still sitting unconfirmed in the mempool. Without this check,
// a slow or stuck confirmation can leave the next cycle's broadcast racing or conflicting with
// it — the same handoff-chain risk class the Dexalot bot's phantom-order rule exists for (an
// SDK call succeeding doesn't mean the chain agrees yet).
//
// Hiro's /extended/v1/address/{addr}/nonces endpoint IS mempool-aware: it reports
// detected_missing_nonces (a real gap between confirmed and expected) and
// detected_mempool_nonces (nonces this account currently has unconfirmed in the mempool).

import { withRpc, hiroHeaders } from "./rpc.js";

export interface NonceSafety {
  safe: boolean;
  reason?: string;
  missingNonces: number[];
  mempoolPending: number;
}

interface NoncesResponse {
  detected_missing_nonces?: number[];
  detected_mempool_nonces?: number[];
}

export async function checkNonceSafety(address: string): Promise<NonceSafety> {
  const j = await withRpc(async (baseUrl) => {
    const r = await fetch(`${baseUrl}/extended/v1/address/${address}/nonces`, { headers: hiroHeaders(baseUrl) });
    if (!r.ok) throw new Error(`nonce check failed: HTTP ${r.status}`);
    return (await r.json()) as NoncesResponse;
  });
  const missingNonces = j.detected_missing_nonces ?? [];
  const mempoolPending = (j.detected_mempool_nonces ?? []).length;
  if (missingNonces.length > 0) {
    return {
      safe: false,
      reason: `nonce gap detected (missing [${missingNonces.join(",")}]); holding until cleared`,
      missingNonces,
      mempoolPending,
    };
  }
  if (mempoolPending > 0) {
    return {
      safe: false,
      reason: `a prior tx is still pending in the mempool (${mempoolPending} nonce${mempoolPending === 1 ? "" : "s"}); holding to avoid piling up nonces`,
      missingNonces,
      mempoolPending,
    };
  }
  return { safe: true, missingNonces, mempoolPending };
}
