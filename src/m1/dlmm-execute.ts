// DLMM executor (step 4 — the ONLY place that can sign/broadcast a DLMM write).
//
// Takes a build-only CallDescriptor (from dlmm-write.ts) and broadcasts it — but ONLY when BOTH
// gates are explicitly set (live && yesMainnet) on mainnet, exactly like the XYK path's double
// opt-in. Anything less is a DRY-RUN that returns what it WOULD do and touches no capital and no
// key. This is the boundary between "built and simulated" and "real money."
//
// POST-CONDITIONS: Allow mode + strict INPUT-CAP post-conditions, matching the proven XYK path
// (actions.ts). The caps bound only what LEAVES the wallet (willSendLte per token), so a
// mis-encoded call can never overspend; the router's own internal transfers (LP mint, per-bin
// moves, fee legs) are permitted. Deny mode was deliberately NOT used: a multi-bin write moves
// assets in many legs, and Deny requires enumerating every one exactly or the tx aborts — the
// same trap that aborted the first XYK swap (95b112e1). Callers MUST pass input-cap
// post-conditions (see dlmm-write.buildInputCaps); broadcasting with none is refused.

import { makeContractCall, broadcastTransaction, PostConditionMode, type PostCondition } from "@stacks/transactions";
import type { CallDescriptor } from "./dlmm-write.js";

// Allow the router's internal transfers; the wallet's spend is bounded by the input-cap
// post-conditions the caller supplies (never Deny — see the header note).
const MODE = PostConditionMode.Allow;

export interface ExecuteOpts {
  live?: boolean; // gate 1 — must be explicitly true to broadcast
  yesMainnet?: boolean; // gate 2 — must be explicitly true to broadcast
  senderKey?: string; // signing key — only read on the broadcast path
  postConditions?: PostCondition[]; // input caps on what leaves the wallet (Allow mode)
  allowNoInputCaps?: boolean; // ONLY for receive-only writes (withdraw): the wallet spends nothing
  feeMicroStx?: bigint;
  nonce?: bigint;
}

export interface ExecuteResult {
  broadcast: boolean;
  dryRun: boolean;
  txid?: string;
  summary: string;
}

/** True only when both explicit gates are set for mainnet. The single source of "may broadcast". */
export function canBroadcast(opts: ExecuteOpts): boolean {
  return opts.live === true && opts.yesMainnet === true;
}

/**
 * Broadcast a descriptor ONLY behind the double opt-in; otherwise a no-capital dry-run. The
 * dry-run path never reads senderKey and never hits the network — safe to call with no wallet.
 */
export async function executeDescriptor(d: CallDescriptor, opts: ExecuteOpts = {}): Promise<ExecuteResult> {
  if (!canBroadcast(opts)) {
    return {
      broadcast: false,
      dryRun: true,
      summary: `DRY-RUN (no broadcast): ${d.functionName} — ${d.note}. Gates: live=${!!opts.live}, yesMainnet=${!!opts.yesMainnet}. ${(opts.postConditions ?? []).length} post-conditions staged.`,
    };
  }
  if (!opts.senderKey) throw new Error("refuse to broadcast: gates set but no senderKey");
  // Refuse to broadcast a spending write with no cap — that is the unsafe path, not a convenience.
  // allowNoInputCaps is the audited exception for receive-only writes (withdraw), where the wallet
  // sends nothing (DLMM LP shares are internal, not a transferable wallet asset).
  if (!opts.allowNoInputCaps && (!opts.postConditions || opts.postConditions.length === 0))
    throw new Error("refuse to broadcast: no input-cap post-conditions (see dlmm-write.buildInputCaps)");
  const tx = await makeContractCall({
    contractAddress: d.contractAddress,
    contractName: d.contractName,
    functionName: d.functionName,
    functionArgs: d.functionArgs,
    senderKey: opts.senderKey,
    network: "mainnet",
    fee: opts.feeMicroStx ?? 200_000n,
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
    postConditions: opts.postConditions ?? [],
    postConditionMode: MODE, // Allow + input caps (see header)
  });
  const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
  const txid = (res as { txid?: string }).txid;
  if (!txid) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
  return { broadcast: true, dryRun: false, txid, summary: `BROADCAST ${d.functionName}: ${txid}` };
}
