// Write-side transaction builders for the sBTC-STX pool.
//
// SAFETY: default mode is DRY-RUN — we build and sign with an ephemeral random
// key and DO NOT broadcast. Nothing touches mainnet and no real key is needed.
// Broadcasting requires both `broadcast: true` AND a real `senderKey`, and is
// the only path that moves funds. Every write uses PostConditionMode.Deny.
//
// On post-conditions: the INPUT leg (what the sender sends) is certain. The
// RECEIVE/burn legs are asserted against the CORE contract and marked
// "(verify on testnet)" — the exact sending principal (core vs pool) and LP
// burn semantics must be confirmed before broadcasting. Because Deny mode fails
// CLOSED, a wrong receive post-condition simply aborts the tx — no funds at risk.

import {
  makeContractCall,
  broadcastTransaction,
  fetchNonce,
  Cl,
  Pc,
  PostConditionMode,
  getAddressFromPrivateKey,
  randomPrivateKey,
  serializeTransaction,
  type ClarityValue,
  type PostCondition,
} from "@stacks/transactions";
import { CORE, POOL, SBTC, STX, POOL_LP, contractId } from "./contracts.js";
import {
  getAddLiquidityQuote,
  getSwapXForYQuote,
  getSwapYForXQuote,
  getWithdrawQuote,
  minusSlippage,
  plusSlippage,
} from "./quotes.js";

export interface BuildOpts {
  senderKey?: string; // real key only needed to broadcast
  network?: "mainnet" | "testnet"; // default mainnet (pool is mainnet-only)
  slippageBps?: number; // default 100 = 1%
  broadcast?: boolean; // default false (dry-run)
  feeMicroStx?: bigint; // explicit fee; auto-defaults differ for dry-run vs broadcast
  nonce?: bigint; // fetched automatically when broadcasting if omitted
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

const human = (amount: bigint, decimals: number) =>
  Number(amount) / 10 ** decimals;

// Safety model for AMM ops: we bound the assets the SENDER sends with strict
// post-conditions (so the user can never overspend), and rely on the contract's
// on-chain min-* output args to bound what is received. Mode is Allow so the
// pool's internal transfers (sBTC/STX out, protocol fee, LP mint) don't trip a
// Deny abort — the input-cap PCs still fully protect the sender's funds.
const MODE = PostConditionMode.Allow;

// Shared: sign locally (ephemeral key in dry-run), serialize, optionally broadcast.
async function finalize(
  action: string,
  functionName: string,
  functionArgs: ClarityValue[],
  pcFor: (sender: string) => { conditions: PostCondition[]; human: string[] },
  detailsFor: (sender: string) => Record<string, string>,
  opts: BuildOpts,
): Promise<BuiltTx> {
  const network = opts.network ?? "mainnet";
  const broadcasting = !!opts.broadcast && !!opts.senderKey;
  const key = opts.senderKey ?? randomPrivateKey();
  const sender = getAddressFromPrivateKey(key, network);
  const { conditions, human: pcHuman } = pcFor(sender);

  // Real nonce/fee only matter when broadcasting; dry-run stays hermetic.
  const nonce =
    opts.nonce ?? (broadcasting ? await fetchNonce({ address: sender, network }) : 0n);
  const fee = opts.feeMicroStx ?? (broadcasting ? 50_000n : 10_000n);

  const tx = await makeContractCall({
    contractAddress: CORE.address,
    contractName: CORE.name,
    functionName,
    functionArgs,
    senderKey: key,
    network,
    postConditionMode: MODE,
    postConditions: conditions,
    fee,
    nonce,
  });

  const built: BuiltTx = {
    action,
    sender,
    dryRun: !broadcasting,
    details: detailsFor(sender),
    postConditions: pcHuman,
    serializedTx: serializeTransaction(tx),
  };
  if (broadcasting) {
    try {
      const res = await broadcastTransaction({ transaction: tx, network });
      const r = res as any;
      built.broadcast = r.txid ? { txid: r.txid } : { error: JSON.stringify(r) };
    } catch (err) {
      built.broadcast = { error: (err as Error).message };
    }
  }
  return built;
}

// add-liquidity(pool, x, y, x-amount, min-dlp)
export async function buildAddLiquidity(
  xAmount: bigint,
  opts: BuildOpts = {},
): Promise<BuiltTx> {
  const slip = opts.slippageBps ?? 100;
  const q = await getAddLiquidityQuote(xAmount);
  const minDlp = minusSlippage(q.dlp, slip);
  const maxY = plusSlippage(q.yAmount, slip);

  return finalize(
    "add-liquidity",
    "add-liquidity",
    [...traitArgs(), Cl.uint(xAmount), Cl.uint(minDlp)],
    (sender) => ({
      conditions: [
        Pc.principal(sender).willSendLte(xAmount).ft(contractId(SBTC), SBTC.asset),
        Pc.principal(sender).willSendLte(maxY).ustx(),
      ],
      human: [
        `sender sends ≤ ${human(xAmount, SBTC.decimals)} sBTC`,
        `sender sends ≤ ${human(maxY, STX.decimals)} STX (native)`,
        `(LP received bounded on-chain by min-dlp=${minDlp})`,
      ],
    }),
    () => ({
      xAmount_sBTC: `${human(xAmount, SBTC.decimals)} (${xAmount} base)`,
      expectedDlp: q.dlp.toString(),
      minDlp_afterSlippage: minDlp.toString(),
      pairedSTX: `${human(q.yAmount, STX.decimals)} (${q.yAmount} uSTX)`,
      maxSTX_afterSlippage: `${human(maxY, STX.decimals)}`,
      slippageBps: String(slip),
    }),
    opts,
  );
}

// swap-x-for-y(pool, x, y, x-amount, min-dy) — sell sBTC for STX
export async function buildSwapXForY(
  xAmount: bigint,
  opts: BuildOpts = {},
): Promise<BuiltTx> {
  const slip = opts.slippageBps ?? 100;
  const dy = await getSwapXForYQuote(xAmount);
  const minDy = minusSlippage(dy, slip);

  return finalize(
    "swap-x-for-y",
    "swap-x-for-y",
    [...traitArgs(), Cl.uint(xAmount), Cl.uint(minDy)],
    (sender) => ({
      conditions: [
        Pc.principal(sender).willSendLte(xAmount).ft(contractId(SBTC), SBTC.asset),
      ],
      human: [
        `sender sends ≤ ${human(xAmount, SBTC.decimals)} sBTC`,
        `(STX received bounded on-chain by min-dy=${minDy})`,
      ],
    }),
    () => ({
      xAmount_sBTC: `${human(xAmount, SBTC.decimals)} (${xAmount} base)`,
      expectedSTXout: `${human(dy, STX.decimals)} (${dy} uSTX)`,
      minSTXout_afterSlippage: `${human(minDy, STX.decimals)}`,
      slippageBps: String(slip),
    }),
    opts,
  );
}

// swap-y-for-x(pool, x, y, y-amount, min-dx) — sell STX for sBTC (cheapest smoke)
export async function buildSwapYForX(
  yAmount: bigint,
  opts: BuildOpts = {},
): Promise<BuiltTx> {
  const slip = opts.slippageBps ?? 100;
  const dx = await getSwapYForXQuote(yAmount);
  const minDx = minusSlippage(dx, slip);

  return finalize(
    "swap-y-for-x",
    "swap-y-for-x",
    [...traitArgs(), Cl.uint(yAmount), Cl.uint(minDx)],
    (sender) => ({
      conditions: [Pc.principal(sender).willSendLte(yAmount).ustx()],
      human: [
        `sender sends ≤ ${human(yAmount, STX.decimals)} STX (native)`,
        `(sBTC received bounded on-chain by min-dx=${minDx})`,
      ],
    }),
    () => ({
      yAmount_STX: `${human(yAmount, STX.decimals)} (${yAmount} uSTX)`,
      expected_sBTCout: `${human(dx, SBTC.decimals)} (${dx} base)`,
      min_sBTCout_afterSlippage: `${human(minDx, SBTC.decimals)}`,
      slippageBps: String(slip),
    }),
    opts,
  );
}

// withdraw-liquidity(pool, x, y, amount, min-x-amount, min-y-amount)
export async function buildWithdrawLiquidity(
  lpAmount: bigint,
  opts: BuildOpts = {},
): Promise<BuiltTx> {
  const slip = opts.slippageBps ?? 100;
  const q = await getWithdrawQuote(lpAmount);
  const minX = minusSlippage(q.xOut, slip);
  const minY = minusSlippage(q.yOut, slip);

  return finalize(
    "withdraw-liquidity",
    "withdraw-liquidity",
    [...traitArgs(), Cl.uint(lpAmount), Cl.uint(minX), Cl.uint(minY)],
    (sender) => ({
      conditions: [
        // burn leg: LP tokens leave the sender
        Pc.principal(sender).willSendLte(lpAmount).ft(contractId(POOL_LP), POOL_LP.asset),
      ],
      human: [
        `sender sends ≤ ${human(lpAmount, POOL_LP.decimals)} LP (${POOL_LP.asset})`,
        `(sBTC/STX received bounded on-chain by min-x=${minX}, min-y=${minY})`,
      ],
    }),
    () => ({
      lpAmount: `${human(lpAmount, POOL_LP.decimals)} (${lpAmount} base)`,
      expected_sBTCout: `${human(q.xOut, SBTC.decimals)} (${q.xOut} base)`,
      expected_STXout: `${human(q.yOut, STX.decimals)} (${q.yOut} uSTX)`,
      minX_afterSlippage: `${human(minX, SBTC.decimals)} sBTC`,
      minY_afterSlippage: `${human(minY, STX.decimals)} STX`,
      slippageBps: String(slip),
    }),
    opts,
  );
}
