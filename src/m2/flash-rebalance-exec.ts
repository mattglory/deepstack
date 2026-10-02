// Shared flash-rebalance broadcast primitives — used by BOTH the manual CLI
// (receiver-cli.ts) and the live agent loop (agent-cli.ts), same role
// src/m1/dlmm-recenter-exec.ts plays for DLMM. One implementation of "arm, wait, flash-loan,
// wait" instead of two copies to keep in sync.
//
// flashRebalanceOnce() is the agent-only orchestrator (mirrors dlmm-recenter-exec.ts's
// recenterOnce()): decide whether a flash-rebalance is worthwhile, then — only when
// live===true — execute it. live===false is pure observe: sizes the trade and returns,
// touches no key and no capital.

import { existsSync } from "node:fs";
import { fetchCallReadOnlyFunction, fetchNonce, makeContractCall, broadcastTransaction, cvToJSON, Cl, Pc, PostConditionMode } from "@stacks/transactions";
import { withRpc, hiroFetch } from "../m1/rpc.js";
import { type Wallet, getStxBalance } from "../m1/wallet.js";
import { getSwapYForXQuote, minusSlippage } from "../m1/quotes.js";
import { checkNonceSafety } from "../m1/nonce-safety.js";
import { flashFee, sizeFlashRebalance, flashRebalanceSequenceOutcome, type SizeFlashRebalanceResult } from "./flash-rebalance.js";

const FLASHSTACK_CORE = { address: "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5", name: "flashstack-stx-core" } as const;
const RECEIVER_NAME = "deepstack-rebalance-receiver";
const CALL_FEE = 50_000n; // µSTX, same as the agent's other contract calls
const SLIP_BPS = 80; // min-dx slippage budget on the armed quote — matches receiver-cli.ts
const GAS_RESERVE_USTX = 100_000_000n; // keep 100 STX for gas, same reserve dlmm-recenter-exec.ts keeps
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readOnly(addr: string, name: string, fn: string, args: any[] = []): Promise<any> {
  return cvToJSON(
    await withRpc((baseUrl) =>
      fetchCallReadOnlyFunction({
        contractAddress: addr,
        contractName: name,
        functionName: fn,
        functionArgs: args,
        network: "mainnet",
        client: { baseUrl, fetch: hiroFetch(baseUrl) },
        senderAddress: addr,
      }),
    ),
  );
}

export async function waitForTx(txid: string, log: (s: string) => void = () => {}): Promise<string> {
  log(`  ${txid} — confirming…`);
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    try {
      const j = await withRpc((baseUrl) =>
        hiroFetch(baseUrl)(`${baseUrl}/extended/v1/tx/${txid}`).then((r) => {
          if (!r.ok) throw new Error(`tx status fetch failed: ${r.status}`);
          return r.json() as Promise<{ tx_status?: string; tx_result?: { repr?: string } }>;
        }),
      );
      if (j.tx_status && j.tx_status !== "pending") {
        log(`  status: ${j.tx_status}${j.tx_result?.repr ? `  ${j.tx_result.repr}` : ""}`);
        return j.tx_status;
      }
    } catch {
      // no endpoint answered (or all timed out) this poll — treat as still-pending, retry
    }
  }
  return "timeout";
}

export interface FlashStackStatus {
  feeBps: number;
  maxSingleLoan: bigint;
  reserveBalance: bigint;
  whitelisted: boolean;
}

export async function readFlashStackStatus(w: Wallet): Promise<FlashStackStatus> {
  const [fee, maxLoan, reserve, approved] = await Promise.all([
    readOnly(FLASHSTACK_CORE.address, FLASHSTACK_CORE.name, "get-fee-basis-points"),
    readOnly(FLASHSTACK_CORE.address, FLASHSTACK_CORE.name, "get-max-single-loan"),
    readOnly(FLASHSTACK_CORE.address, FLASHSTACK_CORE.name, "get-reserve-balance"),
    readOnly(FLASHSTACK_CORE.address, FLASHSTACK_CORE.name, "is-approved-receiver", [Cl.contractPrincipal(w.address, RECEIVER_NAME)]),
  ]);
  return {
    feeBps: Number(fee?.value?.value ?? 5),
    maxSingleLoan: BigInt(maxLoan?.value?.value ?? 0),
    reserveBalance: BigInt(reserve?.value ?? 0),
    whitelisted: Boolean(approved?.value),
  };
}

export async function armRebalance(
  w: Wallet,
  amountStxBase: bigint,
  opts: { broadcast: boolean; slipBps?: number } = { broadcast: true },
): Promise<{ txid?: string; minDx: bigint; quotedDx: bigint }> {
  const quotedDx = await getSwapYForXQuote(amountStxBase);
  const minDx = minusSlippage(quotedDx, opts.slipBps ?? SLIP_BPS);
  if (!opts.broadcast) return { minDx, quotedDx };

  const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
  const tx = await makeContractCall({
    contractAddress: w.address,
    contractName: RECEIVER_NAME,
    functionName: "arm",
    functionArgs: [Cl.uint(amountStxBase), Cl.uint(minDx)],
    senderKey: w.key,
    network: "mainnet",
    fee: CALL_FEE,
    nonce,
    postConditionMode: PostConditionMode.Deny, // arming moves no assets
  });
  const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
  if (!("txid" in res)) throw new Error(`arm broadcast failed: ${JSON.stringify(res)}`);
  return { txid: res.txid, minDx, quotedDx };
}

export async function executeFlashLoanRebalance(
  w: Wallet,
  amountStxBase: bigint,
  opts: { broadcast: boolean } = { broadcast: true },
): Promise<{ txid?: string; repayCap: bigint }> {
  const repayCap = amountStxBase + flashFee(amountStxBase);
  if (!opts.broadcast) return { repayCap };

  const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
  const tx = await makeContractCall({
    contractAddress: FLASHSTACK_CORE.address,
    contractName: FLASHSTACK_CORE.name,
    functionName: "flash-loan",
    functionArgs: [Cl.uint(amountStxBase), Cl.contractPrincipal(w.address, RECEIVER_NAME)],
    senderKey: w.key,
    network: "mainnet",
    fee: CALL_FEE,
    nonce,
    // Allow mode: the core and receiver move STX/sBTC internally (borrowed leg, swap,
    // forwarding) — same rationale as the agent's own swaps. The operator's own outflow is
    // strictly capped at the repayment via the post-condition below.
    postConditionMode: PostConditionMode.Allow,
    postConditions: [Pc.principal(w.address).willSendLte(repayCap).ustx()],
  });
  const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
  if (!("txid" in res)) throw new Error(`flash-loan broadcast failed: ${JSON.stringify(res)}`);
  return { txid: res.txid, repayCap };
}

export interface FlashRebalanceConfig {
  amountStxBase: bigint; // the real (uncapped) deficit — sizeFlashRebalance() clamps it further
  maxAmountStxBase?: bigint; // FLASH_MAX_SWAP_Y_BASE
  slipBps?: number;
  directCapStxBase: bigint; // params.maxSwapYBase — the "would this even help" bar
}

export interface FlashRebalanceResult {
  action: "flash-rebalance" | "skip";
  reason: string;
  requestedAmountStxBase: bigint;
  armedAmountStxBase: bigint;
  executed: boolean;
  // True only for a deliberate pre-broadcast skip (kill switch, nonce gate, not worthwhile) —
  // distinguishes "chose not to try" from "tried and the chain rejected it", same RecenterResult
  // convention dlmm-recenter-exec.ts uses, for the same reason (a caller counting consecutive
  // failures shouldn't penalize a condition expected to clear on its own).
  skipped?: boolean;
  armTxid?: string;
  flashTxid?: string;
}

/**
 * One flash-rebalance attempt. live===false: size + return (observe). live===true: execute
 * the sized amount if it's worthwhile. Never throws to the caller on a sub-step failure —
 * the caller's own try/catch journals it, matching recenterOnce()'s contract.
 */
export async function flashRebalanceOnce(
  w: Wallet,
  cfg: FlashRebalanceConfig,
  live: boolean,
  log: (s: string) => void = () => {},
): Promise<FlashRebalanceResult> {
  const base: Omit<FlashRebalanceResult, "action" | "reason"> = {
    requestedAmountStxBase: cfg.amountStxBase,
    armedAmountStxBase: 0n,
    executed: false,
  };

  if (cfg.amountStxBase <= 0n) return { ...base, action: "skip", reason: "no deficit", skipped: true };

  // Same manual kill switch as dlmm-recenter-exec.ts and the XYK path — one check, same file.
  if (process.env.KILL_SWITCH === "1" || existsSync("KILL")) {
    return { ...base, action: "skip", reason: "kill switch engaged — flash-rebalance skipped", skipped: true };
  }

  const nonceSafety = await checkNonceSafety(w.address).catch(
    (err) => ({ safe: false, reason: `nonce check failed: ${(err as Error).message}`, missingNonces: [], mempoolPending: 0 }),
  );
  if (!nonceSafety.safe) return { ...base, action: "skip", reason: nonceSafety.reason ?? "nonce check failed", skipped: true };

  const [status, balance] = await Promise.all([readFlashStackStatus(w), getStxBalance(w.address, w.network)]);
  if (!status.whitelisted) return { ...base, action: "skip", reason: "receiver not whitelisted on flashstack-stx-core", skipped: true };

  const sized: SizeFlashRebalanceResult = sizeFlashRebalance(cfg.amountStxBase, {
    maxAmountBase: cfg.maxAmountStxBase ?? BigInt(process.env.FLASH_MAX_SWAP_Y_BASE ?? 150_000_000),
    maxSingleLoan: status.maxSingleLoan,
    reserveBalance: status.reserveBalance,
    availableNativeStxBase: balance.microStx,
    gasReserveBase: GAS_RESERVE_USTX,
    directCapBase: cfg.directCapStxBase,
  });
  if (!sized.worthwhile) return { ...base, action: "skip", reason: sized.reason, skipped: true };
  if (!live) return { ...base, action: "skip", reason: `sized ${sized.amountBase} — observe mode`, armedAmountStxBase: sized.amountBase };

  log(`  flash-rebalance 1/2 — arm ${Number(sized.amountBase) / 1e6} STX`);
  const armed = await armRebalance(w, sized.amountBase, { broadcast: true, slipBps: cfg.slipBps });
  if (!armed.txid) throw new Error("arm broadcast returned no txid");
  const armStatus = await waitForTx(armed.txid, log);

  if (armStatus !== "success") {
    const outcome = flashRebalanceSequenceOutcome(armStatus, null);
    return { ...base, action: "flash-rebalance", reason: outcome.reason, armedAmountStxBase: sized.amountBase, armTxid: armed.txid, executed: outcome.executed };
  }

  log(`  flash-rebalance 2/2 — flash-loan ${Number(sized.amountBase) / 1e6} STX`);
  const flashed = await executeFlashLoanRebalance(w, sized.amountBase, { broadcast: true });
  if (!flashed.txid) throw new Error("flash-loan broadcast returned no txid");
  const flashStatus = await waitForTx(flashed.txid, log);

  const outcome = flashRebalanceSequenceOutcome(armStatus, flashStatus);
  return {
    ...base,
    action: "flash-rebalance",
    reason: outcome.reason,
    armedAmountStxBase: sized.amountBase,
    armTxid: armed.txid,
    flashTxid: flashed.txid,
    executed: outcome.executed,
  };
}
