// Write-side transaction builders for the active XYK pair (see contracts.ts).
//
// SAFETY: default mode is DRY-RUN — build + sign with an ephemeral key, no broadcast.
// Broadcasting requires broadcast:true AND a real senderKey. Post-conditions bound
// what the SENDER sends (input caps, so it can never overspend); the contract's on-chain
// min-* args bound what is received. Post-conditions branch on token.native (native STX ->
// .ustx(), SIP-010 -> .ft()), so this works for ANY pair.
//
// MODE: Deny (C3 / DSA-09), with the COMPLETE set of movements each call makes, derived from
// xyk-core-v-1-2 and confirmed on real agent transactions (src/m1/fixtures/agent-asset-flows.json):
//   swap-x-for-y   wallet sends x (to the pool + protocol fee address, both inside the x cap);
//                  the POOL sends y to the wallet (0xc685ec3e…)
//   swap-y-for-x   the mirror (0x093e7748…)
//   add-liquidity  wallet sends x and y; the LP token is minted (a mint has no sender) (0x60a90885…)
//   withdraw       wallet burns LP (a burn counts as the wallet sending it); the POOL sends x and
//                  y to the wallet (0x15610400…, 0x8f16fa78…)
// Every other wallet asset gets "sends ≤ 0" (post-conditions.ts), and Deny forbids anything
// unlisted, NFTs included. The pool's payout is covered by "pool sends ≥ min-out", the same
// bound the core already asserts (dy >= min-dy, x/y-amount >= min-x/min-y), so it adds no new
// way to fail. The first ever XYK swap (0x95b112e1) aborted in Deny mode because that
// condition named xyk-core instead of the pool contract that actually pays.

import {
  makeContractCall,
  fetchNonce,
  Cl,
  PostConditionMode,
  getAddressFromPrivateKey,
  randomPrivateKey,
  serializeTransaction,
  type ClarityValue,
  type PostCondition,
} from "@stacks/transactions";
import { CORE, activePool, contractId, tokenId, type Token } from "./contracts.js";
import { STX, walletOutflowConditions, principalSendsGte, type AssetKey } from "./post-conditions.js";
import { withRpc, hiroFetch, broadcastSigned } from "./rpc.js";
import {
  getAddLiquidityQuote,
  getSwapXForYQuote,
  getSwapYForXQuote,
  getWithdrawQuote,
  minusSlippage,
  plusSlippage,
  floorMinOutByReference,
} from "./quotes.js";

export interface BuildOpts {
  senderKey?: string;
  network?: "mainnet" | "testnet";
  slippageBps?: number;
  broadcast?: boolean;
  feeMicroStx?: bigint;
  nonce?: bigint;
  // External reference mid (y per x, safety.ts getExternalMid). When set, swap min-outs are
  // floored by it (quotes.ts floorMinOutByReference): they can only get stricter.
  refMidXinY?: number;
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

// The post-condition asset key of a pair token — native STX vs SIP-010 FT.
const keyOf = (t: Token): AssetKey => (t.native ? STX : `${tokenId(t)}::${t.asset!}`);
// The pool contract's payout to the wallet (Deny mode must cover it).
const poolPaysPC = (min: bigint, t: Token) => principalSendsGte(contractId(activePool().pool), keyOf(t), min);
const GUARD_NOTE = "every other wallet asset: sends ≤ 0; Deny mode forbids any unlisted movement";
const humanLeg = (amount: bigint, t: Token) =>
  `${human(amount, t.decimals)} ${t.symbol}${t.native ? " (native)" : ""}`;

const MODE = PostConditionMode.Deny;

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
    opts.nonce ??
    (broadcasting ? await withRpc((baseUrl) => fetchNonce({ address: sender, network, client: { baseUrl, fetch: hiroFetch(baseUrl) } })) : 0n);
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
    // Configured endpoints, failover, per-attempt timeout; the same signed tx on every attempt
    // (rpc.ts broadcastSigned, C2 / DSA-08). A node rejection echoes a txid, so "error" decides.
    const r = await broadcastSigned(tx);
    built.broadcast = "error" in r ? { error: r.error } : { txid: r.txid };
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
      conditions: walletOutflowConditions(sender, [{ key: keyOf(x), max: xAmount }, { key: keyOf(y), max: maxY }]),
      human: [
        `sender sends ≤ ${humanLeg(xAmount, x)}`,
        `sender sends ≤ ${humanLeg(maxY, y)}`,
        GUARD_NOTE,
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
  const minDy = opts.refMidXinY === undefined ? minusSlippage(dy, slip)
    : floorMinOutByReference(minusSlippage(dy, slip), "x-for-y", xAmount, opts.refMidXinY, x.decimals, y.decimals, slip);

  return finalize(
    "swap-x-for-y",
    "swap-x-for-y",
    [...traitArgs(), Cl.uint(xAmount), Cl.uint(minDy)],
    (sender) => ({
      conditions: [...walletOutflowConditions(sender, [{ key: keyOf(x), max: xAmount }]), poolPaysPC(minDy, y)],
      human: [`sender sends ≤ ${humanLeg(xAmount, x)}`, GUARD_NOTE, `pool sends ≥ ${minDy} ${y.symbol} base (= on-chain min-dy)`],
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
  const minDx = opts.refMidXinY === undefined ? minusSlippage(dx, slip)
    : floorMinOutByReference(minusSlippage(dx, slip), "y-for-x", yAmount, opts.refMidXinY, x.decimals, y.decimals, slip);

  return finalize(
    "swap-y-for-x",
    "swap-y-for-x",
    [...traitArgs(), Cl.uint(yAmount), Cl.uint(minDx)],
    (sender) => ({
      conditions: [...walletOutflowConditions(sender, [{ key: keyOf(y), max: yAmount }]), poolPaysPC(minDx, x)],
      human: [`sender sends ≤ ${humanLeg(yAmount, y)}`, GUARD_NOTE, `pool sends ≥ ${minDx} ${x.symbol} base (= on-chain min-dx)`],
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
      conditions: [
        ...walletOutflowConditions(sender, [{ key: `${contractId(lp)}::${lp.asset}`, max: lpAmount }]),
        poolPaysPC(minX, x),
        poolPaysPC(minY, y),
      ],
      human: [
        `sender sends ≤ ${human(lpAmount, lp.decimals)} LP (${lp.asset})`,
        GUARD_NOTE,
        `pool sends ≥ ${minX} ${x.symbol} base and ≥ ${minY} ${y.symbol} base (= on-chain min-x, min-y)`,
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
