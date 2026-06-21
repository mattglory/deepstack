// Write-side transaction builders for the sBTC-STX pool.
//
// SAFETY: default mode is DRY-RUN — we build and sign with an ephemeral random
// key and DO NOT broadcast. Nothing touches mainnet and no real key is needed.
// Broadcasting requires both `broadcast: true` AND a real `senderKey`, and is
// the only path that moves funds. Every write uses PostConditionMode.Deny.

import {
  makeContractCall,
  broadcastTransaction,
  Cl,
  Pc,
  PostConditionMode,
  getAddressFromPrivateKey,
  randomPrivateKey,
  serializeTransaction,
} from "@stacks/transactions";
import { CORE, POOL, SBTC, STX, contractId } from "./contracts.js";
import { getAddLiquidityQuote, minusSlippage, plusSlippage } from "./quotes.js";

export interface BuildOpts {
  senderKey?: string; // real key only needed to broadcast
  slippageBps?: number; // default 100 = 1%
  broadcast?: boolean; // default false (dry-run)
  feeMicroStx?: bigint; // explicit fee keeps dry-run hermetic (no network calls)
  nonce?: bigint;
}

export interface BuiltTx {
  action: string;
  sender: string;
  dryRun: boolean;
  details: Record<string, string>;
  postConditions: string[]; // human-readable
  serializedTx: string;
  broadcast?: { txid?: string; error?: string };
}

const traitArgs = () => [
  Cl.contractPrincipal(POOL.address, POOL.name),
  Cl.contractPrincipal(SBTC.address, SBTC.name),
  Cl.contractPrincipal(STX.address, STX.name),
];

// add-liquidity(pool, x, y, x-amount, min-dlp)
export async function buildAddLiquidity(
  xAmount: bigint,
  opts: BuildOpts = {},
): Promise<BuiltTx> {
  const slippageBps = opts.slippageBps ?? 100;
  const broadcasting = !!opts.broadcast && !!opts.senderKey;
  const key = opts.senderKey ?? randomPrivateKey(); // ephemeral for dry-run
  const sender = getAddressFromPrivateKey(key);

  const q = await getAddLiquidityQuote(xAmount);
  const minDlp = minusSlippage(q.dlp, slippageBps);
  const maxY = plusSlippage(q.yAmount, slippageBps); // bound the STX leg we send

  // Deny mode + explicit post-conditions: tx aborts if movements differ.
  const postConditions = [
    Pc.principal(sender).willSendLte(xAmount).ft(contractId(SBTC), SBTC.asset),
    Pc.principal(sender).willSendLte(maxY).ustx(), // native STX leg
  ];

  const tx = await makeContractCall({
    contractAddress: CORE.address,
    contractName: CORE.name,
    functionName: "add-liquidity",
    functionArgs: [...traitArgs(), Cl.uint(xAmount), Cl.uint(minDlp)],
    senderKey: key,
    network: "mainnet",
    postConditionMode: PostConditionMode.Deny,
    postConditions,
    fee: opts.feeMicroStx ?? 10_000n,
    nonce: opts.nonce ?? 0n,
  });

  const built: BuiltTx = {
    action: "add-liquidity",
    sender,
    dryRun: !broadcasting,
    details: {
      xAmount_sBTC: `${Number(xAmount) / 10 ** SBTC.decimals} (${xAmount} base)`,
      expectedDlp: q.dlp.toString(),
      minDlp_afterSlippage: minDlp.toString(),
      pairedSTX: `${Number(q.yAmount) / 10 ** STX.decimals} (${q.yAmount} uSTX)`,
      maxSTX_afterSlippage: `${Number(maxY) / 10 ** STX.decimals} (${maxY} uSTX)`,
      slippageBps: String(slippageBps),
    },
    postConditions: [
      `sender sends ≤ ${Number(xAmount) / 10 ** SBTC.decimals} sBTC (${contractId(SBTC)}::${SBTC.asset})`,
      `sender sends ≤ ${Number(maxY) / 10 ** STX.decimals} STX (native)`,
    ],
    serializedTx: serializeTransaction(tx),
  };

  if (broadcasting) {
    try {
      const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
      built.broadcast = { txid: (res as any).txid };
    } catch (err) {
      built.broadcast = { error: (err as Error).message };
    }
  }
  return built;
}
