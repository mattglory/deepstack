// C3 / DSA-09: every autonomous XYK call (actions.ts), the DLMM executor's mode switch, the flash
// loan's wallet set, and withdrawMinimums. Each XYK transaction is built and signed offline (a
// random key, mocked quotes), deserialized, and its mode and COMPLETE post-condition set compared
// line by line. The sets are then replayed against the asset movements of real agent
// transactions (src/m1/fixtures/agent-asset-flows.json) through a Stacks-semantics evaluator
// (post-conditions.testkit.ts): the observed movements must pass, and any extra outflow of a
// wallet asset (or NFT, or unexpected payer) must abort. DLMM add/withdraw/swap: dlmm-postconditions.test.ts.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { evaluate, fixtureTx, movementsOf, withAmount, show, walletLines, HELD, STX, SBTC, XYK_LP, XYK_POOL as POOL, type Movement } from "./post-conditions.testkit.js";

const realQuotes = await import("./quotes.js");
const Q = { dlp: 1_390_000n, pairedY: 79_000_000n, dy: 41_000_000n, dx: 15_000n, xOut: 101_259n, yOut: 263_587_259n };
mock.module("./quotes.js", {
  namedExports: {
    ...realQuotes,
    getAddLiquidityQuote: async () => ({ dlp: Q.dlp, yAmount: Q.pairedY }),
    getSwapXForYQuote: async () => Q.dy,
    getSwapYForXQuote: async () => Q.dx,
    getWithdrawQuote: async () => ({ xOut: Q.xOut, yOut: Q.yOut }),
  },
});
let broadcastTx: unknown = null;
const realRpc = await import("./rpc.js");
mock.module("./rpc.js", {
  namedExports: { ...realRpc, broadcastSigned: async (tx: unknown) => ((broadcastTx = tx), { txid: "0xfeed" }) },
});

const { deserializeTransaction, wireToPostCondition, PostConditionMode, randomPrivateKey, getAddressFromPrivateKey, Cl } = await import("@stacks/transactions");
const { minusSlippage, plusSlippage } = await import("./quotes.js");
const actions = await import("./actions.js");
const { WALLET_ASSETS, walletOutflowConditions } = await import("./post-conditions.js");
const { executeDescriptor } = await import("./dlmm-execute.js");
const { withdrawMinimums } = await import("./dlmm-write.js");
const { flashLoanPostConditions } = await import("../m2/flash-rebalance-exec.js");

async function decoded(b: { serializedTx: string }) {
  const tx = deserializeTransaction(b.serializedTx);
  return { mode: tx.postConditionMode, pcs: tx.postConditions.values.map((w) => wireToPostCondition(w as never)) };
}

/** Each extra 1-unit outflow that must abort: every held asset the call does not send, an NFT, and an unexpected payer. */
function extras(sender: string, sends: string[]): Movement[] {
  return [
    ...HELD.filter((k) => !sends.includes(k)).map((asset) => ({ principal: sender, asset, amount: 1n })),
    { principal: sender, asset: "nft:SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10::pool-token-id", amount: 1n },
    { principal: POOL, asset: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx::usdcx-token", amount: 1n },
  ];
}

test("WALLET_ASSETS is exactly the held set, each once", () => {
  assert.deepEqual([...WALLET_ASSETS], HELD);
});

test("walletOutflowConditions: caps, then ≤ 0 for every other asset; never both on one asset", () => {
  const s = "SP000000000000000000002Q6VF78";
  assert.deepEqual(show(walletOutflowConditions(s, [{ key: SBTC, max: 5n }, { key: STX, max: 0n }])), walletLines(s, [[SBTC, 5n], [STX, 0n]]));
  assert.deepEqual(show(walletOutflowConditions(s, [{ key: SBTC, max: -3n }])), walletLines(s, [[SBTC, 0n]]));
  assert.throws(() => walletOutflowConditions(s, [{ key: SBTC, max: 1n }, { key: SBTC, max: 2n }]), /duplicate/);
});

// ---- XYK (actions.ts): Deny + the complete set -------------------------------------------------

test("XYK swap-x-for-y: Deny, wallet sBTC ≤ amount, every other asset ≤ 0, pool pays ≥ min-dy", async () => {
  const b = await actions.buildSwapXForY(16_040n);
  const { mode, pcs } = await decoded(b);
  const minDy = minusSlippage(Q.dy, 100);
  assert.equal(mode, PostConditionMode.Deny);
  assert.deepEqual(show(pcs), [...walletLines(b.sender, [[SBTC, 16_040n]]), `${POOL} gte ${minDy} STX`]);

  // Real swap 0xc685ec3e (sBTC to the pool and to the fee address, STX back from the pool) passes
  // at the cap and the minimum; one unit over the cap, or any extra movement, aborts.
  const real = movementsOf(fixtureTx("0xc685ec3e"), b.sender);
  const atLimits = withAmount(withAmount(real, b.sender, SBTC, 16_040n), POOL, STX, minDy);
  assert.equal(evaluate(pcs, "deny", atLimits), null);
  assert.match(evaluate(pcs, "deny", withAmount(atLimits, b.sender, SBTC, 16_041n))!, /sbtc-token/);
  assert.match(evaluate(pcs, "deny", withAmount(atLimits, POOL, STX, minDy - 1n))!, /gte/);
  for (const x of extras(b.sender, [SBTC])) assert.notEqual(evaluate(pcs, "deny", [...atLimits, x]), null, `${x.asset} by ${x.principal} must abort`);
});

test("XYK swap-y-for-x: Deny, wallet STX ≤ amount, every other asset ≤ 0, pool pays ≥ min-dx", async () => {
  const b = await actions.buildSwapYForX(40_611_333n);
  const { mode, pcs } = await decoded(b);
  const minDx = minusSlippage(Q.dx, 100);
  assert.equal(mode, PostConditionMode.Deny);
  assert.deepEqual(show(pcs), [...walletLines(b.sender, [[STX, 40_611_333n]]), `${POOL} gte ${minDx} ${SBTC}`]);

  const real = movementsOf(fixtureTx("0x093e7748"), b.sender); // STX to pool + fee address, sBTC back
  const atLimits = withAmount(withAmount(real, b.sender, STX, 40_611_333n), POOL, SBTC, minDx);
  assert.equal(evaluate(pcs, "deny", atLimits), null);
  for (const x of extras(b.sender, [STX])) assert.notEqual(evaluate(pcs, "deny", [...atLimits, x]), null, `${x.asset} by ${x.principal} must abort`);
});

test("XYK add-liquidity: Deny, wallet sBTC ≤ x and STX ≤ max-y, LP and everything else ≤ 0", async () => {
  const b = await actions.buildAddLiquidity(30_000n);
  const { mode, pcs } = await decoded(b);
  const maxY = plusSlippage(Q.pairedY, 100);
  assert.equal(mode, PostConditionMode.Deny);
  assert.deepEqual(show(pcs), walletLines(b.sender, [[SBTC, 30_000n], [STX, maxY]]));

  const real = movementsOf(fixtureTx("0x60a90885"), b.sender); // sBTC + STX to the pool; LP minted (no sender)
  const atLimits = withAmount(withAmount(real, b.sender, SBTC, 30_000n), b.sender, STX, maxY);
  assert.equal(evaluate(pcs, "deny", atLimits), null);
  for (const x of extras(b.sender, [SBTC, STX])) assert.notEqual(evaluate(pcs, "deny", [...atLimits, x]), null, `${x.asset} by ${x.principal} must abort`);
});

test("XYK withdraw-liquidity: Deny, wallet LP ≤ amount (the burn), everything else ≤ 0, pool pays ≥ min-x and ≥ min-y", async () => {
  const lp = 4_720_635n;
  const b = await actions.buildWithdrawLiquidity(lp);
  const { mode, pcs } = await decoded(b);
  const minX = minusSlippage(Q.xOut, 100), minY = minusSlippage(Q.yOut, 100);
  assert.equal(mode, PostConditionMode.Deny);
  assert.deepEqual(show(pcs), [...walletLines(b.sender, [[XYK_LP, lp]]), `${POOL} gte ${minX} ${SBTC}`, `${POOL} gte ${minY} STX`]);

  for (const id of ["0x15610400", "0x8f16fa78"]) {
    const real = movementsOf(fixtureTx(id), b.sender); // LP burned by the wallet; sBTC + STX from the pool
    const atLimits = withAmount(withAmount(withAmount(real, b.sender, XYK_LP, lp), POOL, SBTC, minX), POOL, STX, minY);
    assert.equal(evaluate(pcs, "deny", atLimits), null, id);
    for (const x of extras(b.sender, [XYK_LP])) assert.notEqual(evaluate(pcs, "deny", [...atLimits, x]), null, `${id}: ${x.asset} by ${x.principal} must abort`);
  }
});

// ---- DLMM executor mode ------------------------------------------------------------------------

test("executeDescriptor: Allow by default, Deny when asked; the conditions are signed as given", async () => {
  const key = randomPrivateKey();
  const s = getAddressFromPrivateKey(key, "mainnet");
  const pcs = walletOutflowConditions(s, [{ key: SBTC, max: 7n }]);
  const d = { contractAddress: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD", contractName: "dlmm-swap-router-v-1-2", functionName: "swap-x-for-y-simple-multi", functionArgs: [Cl.uint(1)], note: "test" };
  for (const deny of [false, true]) {
    broadcastTx = null;
    await executeDescriptor(d, { live: true, yesMainnet: true, senderKey: key, postConditions: pcs, deny, nonce: 1n, feeMicroStx: 1n });
    const tx = broadcastTx as { postConditionMode: number; postConditions: { values: unknown[] } };
    assert.equal(tx.postConditionMode, deny ? PostConditionMode.Deny : PostConditionMode.Allow);
    assert.deepEqual(show(tx.postConditions.values.map((w) => wireToPostCondition(w as never))), walletLines(s, [[SBTC, 7n]]));
  }
});

// ---- flash loan (route disabled; Allow kept: the core/receiver move assets between themselves) ----

test("flash-loan: wallet STX ≤ repay cap, every other wallet asset ≤ 0", () => {
  const s = "SP000000000000000000002Q6VF78";
  assert.deepEqual(show(flashLoanPostConditions(s, 57_013_790n)), walletLines(s, [[STX, 57_013_790n]]));
  // Real flash loan 0x55b4e158: the wallet's only outflow is the STX repayment; the receiver
  // contract, core and pool move STX/sBTC among themselves (fine in Allow).
  const pcs = flashLoanPostConditions(s, 57_013_790n);
  const real = movementsOf(fixtureTx("0x55b4e158"), s);
  assert.equal(evaluate(pcs, "allow", real), null);
  for (const x of extras(s, [STX]).filter((m) => m.principal === s && !m.asset.startsWith("nft:")))
    assert.notEqual(evaluate(pcs, "allow", [...real, x]), null, `${x.asset} must abort`);
});

// ---- withdrawMinimums ----------------------------------------------------------------------------

test("withdrawMinimums: (1 - tolerance) of each side read, never below 1 on a held side, 0 on an empty one", () => {
  const bins = [
    { signedBin: -2, userShares: 10n, userX: 0n, userY: 1_000_000n },
    { signedBin: -1, userShares: 11n, userX: 0n, userY: 19n }, // 19 * 0.95 = 18.05 -> 18
    { signedBin: 0, userShares: 12n, userX: 1n, userY: 1n }, // dust: floor would be 0 -> 1
    { signedBin: 1, userShares: 13n, userX: 2_000n, userY: 0n },
  ];
  assert.deepEqual(withdrawMinimums(bins, 500), [
    { signedBin: -2, amount: 10n, minX: 0n, minY: 950_000n },
    { signedBin: -1, amount: 11n, minX: 0n, minY: 18n },
    { signedBin: 0, amount: 12n, minX: 1n, minY: 1n },
    { signedBin: 1, amount: 13n, minX: 1_900n, minY: 0n },
  ]);
  assert.equal(withdrawMinimums(bins, 0)[0].minY, 1_000_000n);
  for (const bad of [-1, 10_000, 1.5, Number.NaN]) assert.throws(() => withdrawMinimums(bins, bad), /tolerance/);
});
