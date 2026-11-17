// C3 / DSA-09 for the autonomous DLMM writes (dlmm-recenter-exec.ts), through the B5 harness
// (dlmm-recenter-exec.harness.ts), which records each executeDescriptor call's opts: the exact
// post-condition set and mode of the withdraw, the rebalance swap and the re-add, the withdraw's
// per-bin min-outs, and a replay of real agent transactions' movements
// (src/m1/fixtures/agent-asset-flows.json) through the Stacks-semantics evaluator.

import { chain, resetChain, load, cycle, positionAround, fns, WALLET, SBTC_ASSET, USDCX_ASSET } from "./dlmm-recenter-exec.harness.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PostCondition } from "@stacks/transactions";
import { evaluate, fixtureTx, movementsOf, withAmount, show, walletLines, HELD, type Movement } from "./post-conditions.testkit.js";

const W = WALLET.address;
const POOL = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10";
const SHARES = `${POOL}::pool-token`;
const TAG = `nft:${POOL}::pool-token-id`;
const ok = { status: "success" };
const WD = "withdraw-liquidity-multi", ADD = "add-liquidity-multi", SWAP_YX = "swap-y-for-x-simple-multi";

beforeEach(() => {
  resetChain();
  process.env.DLMM_MAX_TARGET_USD = "100000";
});

/** Out of range: 7 USDCx-only bins at [-3..3] (50 USDCx each), active bin 10 — withdraw, one swap, re-add. */
async function recenter() {
  chain.position = positionAround(0, 3, 0n, 50_000_000n);
  chain.activeBin = 10;
  chain.plan = [ok, ok, ok];
  const r = await cycle(await load());
  assert.equal(r.res!.executed, true, r.error?.message ?? r.res!.reason);
  assert.deepEqual(fns(), [WD, SWAP_YX, ADD]);
  const [wd, swap, add] = chain.broadcasts;
  const pcs = (b: { opts: Record<string, unknown> }) => b.opts.postConditions as PostCondition[];
  return { wd, swap, add, pcs };
}
const extras = (sends: string[]): Movement[] => HELD.filter((k) => !sends.includes(k)).map((asset) => ({ principal: W, asset, amount: 1n }));

test("withdraw: Allow, the pool shares burned ≤ exactly the shares withdrawn, every other wallet asset ≤ 0; no uncapped exemption", async () => {
  const { wd, pcs } = await recenter();
  assert.equal(wd.opts.allowNoInputCaps, undefined);
  assert.ok(!wd.opts.deny, "Allow: the pool burns and re-mints the wallet's share-tag NFTs");
  assert.deepEqual(show(pcs(wd)), walletLines(W, [[SHARES, 7n * 1_000_000n]]));

  // Real withdraws: shares burned by the wallet, the share-tag NFTs burned (and re-minted),
  // sBTC/USDCx paid by the pool. Pass at the cap; one share more, or any other wallet outflow, aborts.
  for (const id of ["0x235e157e", "0x81b659c9"]) {
    const real = withAmount(movementsOf(fixtureTx(id), W), W, SHARES, 7_000_000n);
    assert.ok(real.some((m) => m.asset === TAG && m.principal === W), "the fixture shows the tag burns");
    assert.equal(evaluate(pcs(wd), "allow", real), null, id);
    assert.match(evaluate(pcs(wd), "allow", withAmount(real, W, SHARES, 7_000_001n))!, /pool-token/);
    for (const x of extras([SHARES])) assert.notEqual(evaluate(pcs(wd), "allow", [...real, x]), null, `${id}: ${x.asset} must abort`);
  }
});

test("withdraw min-outs: 95% of each side the fresh position read shows (DLMM_WITHDRAW_MIN_OUT_TOLERANCE_BPS default 500), not 1", async () => {
  const { wd } = await recenter();
  assert.deepEqual(wd.mins, Array(7).fill({ x: 0n, y: 47_500_000n }));
});

test("withdraw min-outs follow DLMM_WITHDRAW_MIN_OUT_TOLERANCE_BPS (read at load)", async () => {
  process.env.DLMM_WITHDRAW_MIN_OUT_TOLERANCE_BPS = "1000";
  const { wd } = await recenter();
  assert.deepEqual(wd.mins, Array(7).fill({ x: 0n, y: 45_000_000n }));
});

test("withdraw min-out tolerance invalid -> throws before any broadcast (fail closed)", async () => {
  process.env.DLMM_WITHDRAW_MIN_OUT_TOLERANCE_BPS = "10000";
  chain.position = positionAround(0, 3, 0n, 50_000_000n);
  chain.activeBin = 10;
  const r = await cycle(await load());
  assert.match(r.error!.message, /tolerance/);
  assert.deepEqual(fns(), []);
});

test("rebalance swap: Deny, wallet input ≤ amount-in, every other wallet asset ≤ 0, pool pays ≥ min-out", async () => {
  const { swap, pcs } = await recenter();
  assert.equal(swap.opts.deny, true);
  assert.deepEqual(show(pcs(swap)), [...walletLines(W, [[USDCX_ASSET, swap.amountIn!]]), `${POOL} gte ${swap.minOut} ${SBTC_ASSET}`]);

  // Real swap 0x01e9b7f5 on the same pool: USDCx in, sBTC out — nothing else moves.
  const real = withAmount(withAmount(movementsOf(fixtureTx("0x01e9b7f5"), W), W, USDCX_ASSET, swap.amountIn!), POOL, SBTC_ASSET, swap.minOut!);
  assert.equal(evaluate(pcs(swap), "deny", real), null);
  assert.notEqual(evaluate(pcs(swap), "deny", withAmount(real, POOL, SBTC_ASSET, swap.minOut! - 1n)), null);
  for (const x of [...extras([USDCX_ASSET]), { principal: W, asset: TAG, amount: 1n }, { principal: POOL, asset: USDCX_ASSET, amount: 1n }])
    assert.notEqual(evaluate(pcs(swap), "deny", [...real, x]), null, `${x.asset} by ${x.principal} must abort`);
});

test("re-add: Allow, wallet sBTC/USDCx ≤ the deposit + 2% fee headroom (unchanged caps), shares and every other asset ≤ 0", async () => {
  const { add, pcs } = await recenter();
  assert.ok(!add.opts.deny);
  assert.deepEqual(show(pcs(add)), walletLines(W, [[SBTC_ASSET, add.x + add.x / 50n], [USDCX_ASSET, add.y + add.y / 50n]]));

  for (const id of ["0x01bd77b5", "0x70ff19cc"]) {
    // Real adds: sBTC + USDCx to the pool, share-tag NFT burns; shares are minted (no sender).
    const real = withAmount(withAmount(movementsOf(fixtureTx(id), W), W, SBTC_ASSET, add.x), W, USDCX_ASSET, add.y);
    assert.equal(evaluate(pcs(add), "allow", real), null, id);
    for (const x of extras([SBTC_ASSET, USDCX_ASSET])) assert.notEqual(evaluate(pcs(add), "allow", [...real, x]), null, `${id}: ${x.asset} must abort`);
  }
});
