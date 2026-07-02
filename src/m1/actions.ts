// Write-side transaction builders for the active XYK pair (see contracts.ts).
//
// SAFETY: default mode is DRY-RUN — build + sign with an ephemeral key, no broadcast.
// Broadcasting requires broadcast:true AND a real senderKey. Post-conditions bound
// what the SENDER sends (input caps, so it can never overspend); the contract's on-chain
// min-* args bound what is received. Mode is Allow so the pool's internal transfers
// (output leg, protocol fee, LP mint) don't trip a Deny abort. Post-conditions branch on
// token.native (native STX -> .ustx(), SIP-010 -> .ft()), so this works for ANY pair.

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
import { CORE, activePool, contractId, tokenId, type Token } from "./contracts.js";
import {
  getAddLiquidityQuote,
  getSwapXForYQuote,
  getSwapYForXQuote,
  getWithdrawQuote,
  minusSlippage,
  plusSlippage,
} from "./quotes.js";

export interface BuildOpts {
  senderKey?: string;
  network?: "mainnet" | "testnet";
  slippageBps?: number;
  broadcast?: boolean;
  feeMicroStx?: bigint;
  nonce?: bigint;
}

export interface BuiltTx {
  action: string;
  sender: string;
  dryRun: boolean;
  details: Record<string, string>;
  postConditions: string[];
  serializedTx: string;
  broadcast?: { txid?: string; error?: string };
}

const traitArgs = () => {
  const p = activePool();
  return [
    Cl.contractPrincipal(p.pool.address, p.pool.name),
    Cl.contractPrincipal(p.x.address, p.x.name),
    Cl.contractPrincipal(p.y.address, p.y.name),
  ];
};

const human = (amount: bigint, decimals: number) => Number(amount) / 10 ** decimals;

// "sender sends ≤ amount of token" — native STX vs SIP-010 FT.
function sendCapPC(sender: string, amount: bigint, t: Token): PostCondition {
  return t.native
    ? Pc.principal(sender).willSendLte(amount).ustx()
    : Pc.principal(sender).willSendLte(amount).ft(tokenId(t), t.asset!);
}
const humanLeg = (amount: bigint, t: Token) =>
  `${human(amount, t.decimals)} ${t.symbol}${t.native ? " (native)" : ""}`;

const MODE = PostConditionMode.Allow;

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

// add-liquidity(pool, x, y, x-amount, min-dlp) — provide xAmount of x + paired y
export async function buildAddLiquidity(xAmount: bigint, opts: BuildOpts = {}): Promise<BuiltTx> {
  const { x, y } = activePool();
  const slip = opts.slippageBps ?? 100;
  const q = await getAddLiquidityQuote(xAmount);
  const minDlp = minusSlippage(q.dlp, slip);
  const maxY = plusSlippage(q.yAmount, slip);

  return finalize(
    "add-liquidity",
    "add-liquidity",
    [...traitArgs(), Cl.uint(xAmount), Cl.uint(minDlp)],
    (sender) => ({
      conditions: [sendCapPC(sender, xAmount, x), sendCapPC(sender, maxY, y)],
      human: [
        `sender sends ≤ ${humanLeg(xAmount, x)}`,
        `sender sends ≤ ${humanLeg(maxY, y)}`,
        `(LP received bounded on-chain by min-dlp=${minDlp})`,
      ],
    }),
    () => ({
      [`xAmount_${x.symbol}`]: `${human(xAmount, x.decimals)} (${xAmount} base)`,
      expectedDlp: q.dlp.toString(),
      minDlp_afterSlippage: minDlp.toString(),
      [`paired_${y.symbol}`]: `${human(q.yAmount, y.decimals)} (${q.yAmount} base)`,
      [`max_${y.symbol}_afterSlippage`]: `${human(maxY, y.decimals)}`,
      slippageBps: String(slip),
    }),
    opts,
  );
}

// swap-x-for-y(pool, x, y, x-amount, min-dy) — sell x for y
export async function buildSwapXForY(xAmount: bigint, opts: BuildOpts = {}): Promise<BuiltTx> {
  const { x, y } = activePool();
  const slip = opts.slippageBps ?? 100;
  const dy = await getSwapXForYQuote(xAmount);
  const minDy = minusSlippage(dy, slip);

  return finalize(
    "swap-x-for-y",
    "swap-x-for-y",
    [...traitArgs(), Cl.uint(xAmount), Cl.uint(minDy)],
    (sender) => ({
      conditions: [sendCapPC(sender, xAmount, x)],
      human: [`sender sends ≤ ${humanLeg(xAmount, x)}`, `(${y.symbol} received bounded on-chain by min-dy=${minDy})`],
    }),
    () => ({
      [`xAmount_${x.symbol}`]: `${human(xAmount, x.decimals)} (${xAmount} base)`,
      [`expected_${y.symbol}_out`]: `${human(dy, y.decimals)} (${dy} base)`,
      [`min_${y.symbol}_afterSlippage`]: `${human(minDy, y.decimals)}`,
      slippageBps: String(slip),
    }),
    opts,
  );
}

// swap-y-for-x(pool, x, y, y-amount, min-dx) — sell y for x
export async function buildSwapYForX(yAmount: bigint, opts: BuildOpts = {}): Promise<BuiltTx> {
  const { x, y } = activePool();
  const slip = opts.slippageBps ?? 100;
  const dx = await getSwapYForXQuote(yAmount);
  const minDx = minusSlippage(dx, slip);

  return finalize(
    "swap-y-for-x",
    "swap-y-for-x",
    [...traitArgs(), Cl.uint(yAmount), Cl.uint(minDx)],
    (sender) => ({
      conditions: [sendCapPC(sender, yAmount, y)],
      human: [`sender sends ≤ ${humanLeg(yAmount, y)}`, `(${x.symbol} received bounded on-chain by min-dx=${minDx})`],
    }),
    () => ({
      [`yAmount_${y.symbol}`]: `${human(yAmount, y.decimals)} (${yAmount} base)`,
      [`expected_${x.symbol}_out`]: `${human(dx, x.decimals)} (${dx} base)`,
      [`min_${x.symbol}_afterSlippage`]: `${human(minDx, x.decimals)}`,
      slippageBps: String(slip),
    }),
    opts,
  );
}

// withdraw-liquidity(pool, x, y, amount, min-x-amount, min-y-amount)
export async function buildWithdrawLiquidity(lpAmount: bigint, opts: BuildOpts = {}): Promise<BuiltTx> {
  const { x, y, lp } = activePool();
  const slip = opts.slippageBps ?? 100;
  const q = await getWithdrawQuote(lpAmount);
  const minX = minusSlippage(q.xOut, slip);
  const minY = minusSlippage(q.yOut, slip);

  return finalize(
    "withdraw-liquidity",
    "withdraw-liquidity",
    [...traitArgs(), Cl.uint(lpAmount), Cl.uint(minX), Cl.uint(minY)],
    (sender) => ({
      conditions: [Pc.principal(sender).willSendLte(lpAmount).ft(contractId(lp), lp.asset)],
      human: [
        `sender sends ≤ ${human(lpAmount, lp.decimals)} LP (${lp.asset})`,
        `(${x.symbol}/${y.symbol} received bounded on-chain by min-x=${minX}, min-y=${minY})`,
      ],
    }),
    () => ({
      lpAmount: `${human(lpAmount, lp.decimals)} (${lpAmount} base)`,
      [`expected_${x.symbol}_out`]: `${human(q.xOut, x.decimals)} (${q.xOut} base)`,
      [`expected_${y.symbol}_out`]: `${human(q.yOut, y.decimals)} (${q.yOut} base)`,
      slippageBps: String(slip),
    }),
    opts,
  );
}
