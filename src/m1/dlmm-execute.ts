// DLMM executor (step 4 — the ONLY place that can sign/broadcast a DLMM write).
//
// Takes a build-only CallDescriptor (from dlmm-write.ts) and broadcasts it — but ONLY when BOTH
// gates are explicitly set (live && yesMainnet) on mainnet, exactly like the XYK path's double
// opt-in. Anything less is a DRY-RUN that returns what it WOULD do and touches no capital and no
// key. This is the boundary between "built and simulated" and "real money."
//
// POST-CONDITIONS: callers pass the wallet's COMPLETE outflow set (post-conditions.ts
// walletOutflowConditions: each input capped, every other wallet asset "sends ≤ 0"; C3 / DSA-09).
// Mode is Allow by default and Deny when the caller sets deny:true:
//   - add / withdraw stay Allow. Every mint or burn of shares also burns the wallet's existing
//     pool-token-id NFT tag for that bin, if it has one, and mints a new one (the pool's
//     tag-pool-token-id; seen on every add/withdraw, e.g. 0x01bd77b5…, 0x235e157e…). Deny
//     would need a condition naming each burned tag, and whether a tag exists for a new bin is
//     not known before the call; one miss aborts the whole tx (the trap that aborted the first
//     XYK swap, 0x95b112e1). The tags carry no value — the shares are the pool-token FT,
//     which the wallet set guards — so Allow + the complete FT set loses nothing.
//   - swaps run Deny: the only movements are the wallet's input to the pool and the pool's
//     payout to the wallet (dlmm-core swap-x-for-y / swap-y-for-x; 0xc21c79c8…, 0x01e9b7f5…),
//     so the caller adds "pool sends ≥ min-out" and nothing else can move.
// Broadcasting with no post-conditions is refused unless allowNoInputCaps (manual CLI only).

import { makeContractCall, PostConditionMode, type PostCondition } from "@stacks/transactions";
import { broadcastSigned } from "./rpc.js";
import type { CallDescriptor } from "./dlmm-write.js";

export interface ExecuteOpts {
  live?: boolean; // gate 1 — must be explicitly true to broadcast
  yesMainnet?: boolean; // gate 2 — must be explicitly true to broadcast
  senderKey?: string; // signing key — only read on the broadcast path
  postConditions?: PostCondition[]; // the wallet's complete outflow set (see header)
  deny?: boolean; // Deny mode — only for calls whose every movement the conditions cover (swaps)
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
    postConditionMode: opts.deny ? PostConditionMode.Deny : PostConditionMode.Allow, // see header
  });
  // Configured endpoints, failover, per-attempt timeout; same signed tx on every attempt (C2).
  // A node rejection echoes a txid, so "error" decides — not the txid's presence.
  const res = await broadcastSigned(tx);
  if ("error" in res) throw new Error(`broadcast failed: ${res.error}`);
  const txid = res.txid;
  return { broadcast: true, dryRun: false, txid, summary: `BROADCAST ${d.functionName}: ${txid}` };
}
