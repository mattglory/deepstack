// Fault injection for the DLMM recenter orchestrator (recenterOnce), through the harness in
// dlmm-recenter-exec.harness.ts. Every step of open / withdraw -> swaps -> re-add is made to
// fail, abort, time out or be interrupted by KILL, and "restart" loads a fresh module instance
// with the state files kept. Assertions are on the simulated chain: what was broadcast (and
// whether KILL was engaged at that moment), the persisted pending re-add, and the outcome as the
// agent's fail-streak counts it. B5 / DSA-14. No network, nothing signed.

import {
  chain, resetChain, load, cycle, confirm, touchKill, clearKill, streakEffect, fns, positionAround,
  PENDING_PATH, BTC_USD,
} from "./dlmm-recenter-exec.harness.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const XYK_SBTC = 1_000_000n; // the XYK side's free sBTC in the same wallet ($1,000): must never be pulled into the DLMM

beforeEach(() => {
  resetChain();
  process.env.DLMM_MAX_TARGET_USD = "100000"; // the cap is exercised on its own below
});
afterEach(() => {
  for (const b of chain.broadcasts) assert.equal(b.killed, false, `${b.fn} broadcast while KILL was engaged`);
  for (const u of chain.fetches) {
    assert.match(u, /^https:\/\/(rpc\.invalid\/(extended\/v1\/(tx|address)|v2\/contracts\/interface)\/|coins\.llama\.fi\/prices\/current\/coingecko:bitcoin$)/, `unexpected network call ${u}`);
  }
});

type Pending = { pair: string; xBase: string; yBase: string; abortedSwaps: number; pendingSwap?: { txid: string; direction: string }; before: { x: number; y: number } };
const pending = (): Pending | null => (existsSync(PENDING_PATH) ? JSON.parse(readFileSync(PENDING_PATH, "utf8")) : null);
const writePending = (p: Partial<Omit<Pending, "xBase" | "yBase">> & { xBase: bigint; yBase: bigint }) => {
  mkdirSync(dirname(PENDING_PATH), { recursive: true });
  writeFileSync(PENDING_PATH, JSON.stringify({ pair: "sbtc-usdcx", before: { x: 0, y: 0.35 }, t: "2026-11-03T00:00:00Z", abortedSwaps: 0, ...p, xBase: p.xBase.toString(), yBase: p.yBase.toString() }));
};
const count = (fn: string) => fns().filter((f) => f === fn).length;
const WD = "withdraw-liquidity-multi", ADD = "add-liquidity-multi", SWAP_YX = "swap-y-for-x-simple-multi", SWAP_XY = "swap-x-for-y-simple-multi";
const adds = () => chain.broadcasts.filter((b) => b.fn === ADD);
const ok = { status: "success" };

/**
 * Out of range: a 7-bin position at [-3..3] holding only USDCx (price moved up through it),
 * active bin 10, plus the XYK side's sBTC in the wallet. `perBinY` USDCx base per bin.
 * 50 USDCx/bin ($350) needs one y-for-x swap; 500/bin ($3,500) needs three; 1,430/bin
 * (~$10,000) needs more than the 6 allowed per cycle.
 */
function outOfRange(perBinY: bigint) {
  chain.position = positionAround(0, 3, 0n, perBinY);
  chain.activeBin = 10;
  chain.sbtc = XYK_SBTC;
  chain.usdcx = 0n;
}
const withdrawnY = (perBinY: bigint) => perBinY * 7n;
/** What the re-add must deposit: the position's own tokens after swaps, less the 2% held back. */
const expectReadd = (x: bigint, y: bigint) => ({ x: x - x / 50n, y: y - y / 50n });
/** The position's own sBTC after swaps = wallet sBTC minus the XYK side's. */
const ownX = () => chain.sbtc - XYK_SBTC;

// ---- hold / observe -------------------------------------------------------------------------

test("hold: active inside the position -> no broadcast, not an attempt", async () => {
  chain.position = positionAround(0, 3, 10_000n, 10_000_000n);
  const r = await cycle(await load());
  assert.equal(r.res!.action, "hold");
  assert.deepEqual(fns(), []);
  assert.deepEqual(streakEffect(r), { attempted: false, executed: false, tickFailed: false });
});

test("observe (live=false): decides recenter but broadcasts nothing and saves nothing", async () => {
  outOfRange(50_000_000n);
  const r = await cycle(await load(), { live: false });
  assert.equal(r.res!.action, "recenter");
  assert.deepEqual(fns(), []);
  assert.equal(pending(), null);
});

// ---- open -----------------------------------------------------------------------------------

test("open: success -> one add sized 50/50 to target, basis reset, deposit recorded", async () => {
  chain.sbtc = 1_000_000n;
  chain.usdcx = 500_000_000n;
  chain.plan = [ok];
  const r = await cycle(await load());
  assert.equal(r.res!.action, "open");
  assert.equal(r.res!.executed, true);
  assert.deepEqual(fns(), [ADD]);
  // $200 target: $100 of sBTC (100,000 sats) + 100 USDCx
  assert.equal(adds()[0].x, 100_000n);
  assert.equal(adds()[0].y, 100_000_000n);
  assert.equal(chain.basis.length, 1);
  assert.deepEqual(chain.depositsRecorded, [adds()[0].txid]);
  assert.deepEqual(streakEffect(r), { attempted: true, executed: true, tickFailed: false });
});

test("open: add aborts on chain -> not executed, counted as a failed attempt, nothing pending", async () => {
  chain.sbtc = 1_000_000n;
  chain.usdcx = 500_000_000n;
  chain.plan = [{ status: "abort_by_response" }];
  const r = await cycle(await load());
  assert.equal(r.res!.executed, false);
  assert.match(r.res!.reason, /open abort_by_response/);
  assert.equal(chain.basis.length, 0);
  assert.equal(pending(), null);
  assert.deepEqual(streakEffect(r), { attempted: true, executed: false, tickFailed: true });
});

test("open: broadcast rejected (throws) -> recenterOnce throws, the caller counts a failed attempt", async () => {
  chain.sbtc = 1_000_000n;
  chain.usdcx = 500_000_000n;
  chain.plan = [{ throws: "broadcast failed: ConflictingNonceInMempool" }];
  const r = await cycle(await load());
  assert.match(r.error!.message, /ConflictingNonceInMempool/);
  assert.deepEqual(streakEffect(r), { attempted: true, executed: false, tickFailed: true });
});

test("open: add times out -> next cycle, while it is still in the mempool, the nonce gate holds (no second add)", async () => {
  chain.sbtc = 1_000_000n;
  chain.usdcx = 500_000_000n;
  chain.plan = [{ status: "timeout" }];
  const r1 = await cycle(await load());
  assert.equal(r1.res!.executed, false);
  assert.match(r1.res!.reason, /open timeout/);
  // Restart. The add is still unconfirmed, so the position reads empty and the decision is
  // "open" again: the only thing between this and a second add is the nonce gate.
  chain.nonce = { safe: false, reason: "a prior tx is still pending in the mempool (1 nonce)" };
  const r2 = await cycle(await load());
  assert.equal(r2.res!.action, "open");
  assert.equal(r2.res!.skipped, true);
  assert.equal(count(ADD), 1);
  // It confirms; the next cycle holds.
  confirm(adds()[0].txid!);
  chain.nonce = { safe: true };
  const r3 = await cycle(await load());
  assert.equal(r3.res!.action, "hold");
  assert.equal(count(ADD), 1);
});

test("open: KILL engaged -> skipped before any broadcast, not counted as a failure", async () => {
  chain.sbtc = 1_000_000n;
  chain.usdcx = 500_000_000n;
  touchKill();
  const r = await cycle(await load());
  assert.equal(r.res!.skipped, true);
  assert.match(r.res!.reason, /kill switch/);
  assert.deepEqual(fns(), []);
  assert.deepEqual(streakEffect(r), { attempted: false, executed: false, tickFailed: false });
});

// ---- withdraw -------------------------------------------------------------------------------

test("withdraw rejected (throws) -> nothing pending, position intact, no further broadcast", async () => {
  outOfRange(50_000_000n);
  chain.plan = [{ throws: "broadcast failed: NotEnoughFunds" }];
  const r = await cycle(await load());
  assert.match(r.error!.message, /NotEnoughFunds/);
  assert.deepEqual(fns(), [WD]);
  assert.equal(pending(), null);
  assert.equal(chain.position.length, 7);
  assert.deepEqual(streakEffect(r), { attempted: true, executed: false, tickFailed: true });
});

test("withdraw aborts -> aborted before re-add, nothing pending, counted as a failed attempt (no alert flag)", async () => {
  outOfRange(50_000_000n);
  chain.plan = [{ status: "abort_by_post_condition" }];
  const r = await cycle(await load());
  assert.deepEqual(fns(), [WD]);
  assert.equal(r.res!.executed, false);
  assert.equal(r.res!.alert, undefined);
  assert.match(r.res!.reason, /withdraw abort_by_post_condition — aborted before re-add/);
  assert.equal(r.res!.withdrawTxid, chain.broadcasts[0].txid);
  assert.equal(pending(), null);
  assert.equal(chain.position.length, 7, "funds still in the position");
  assert.deepEqual(streakEffect(r), { attempted: true, executed: false, tickFailed: true });
  // Next cycle simply retries the recenter: one more withdraw, no stale state.
  chain.plan = [ok, ok, ok];
  const r2 = await cycle(await load());
  assert.equal(r2.res!.executed, true);
  assert.deepEqual(fns(), [WD, WD, SWAP_YX, ADD]);
});

test("withdraw times out -> nothing pending; if it confirms later the next cycle takes the OPEN path (documents a gap)", async () => {
  outOfRange(50_000_000n);
  chain.plan = [{ status: "timeout" }];
  const r = await cycle(await load());
  assert.equal(r.res!.executed, false);
  assert.match(r.res!.reason, /withdraw timeout — aborted before re-add/);
  assert.equal(pending(), null, "a withdraw that has not confirmed is not recorded as a pending re-add");
  assert.deepEqual(streakEffect(r), { attempted: true, executed: false, tickFailed: true });

  // Restart while it is still in the mempool: the position still reads full, the decision is
  // recenter again, and the nonce gate is what prevents a second withdraw.
  chain.nonce = { safe: false, reason: "a prior tx is still pending in the mempool (1 nonce)" };
  const r2 = await cycle(await load());
  assert.equal(r2.res!.skipped, true);
  assert.equal(count(WD), 1, "never a second withdraw");

  // It confirms late. TODAY: there is no pending record, so the empty position reads as "flat
  // wallet -> open", sized 50/50 to targetUsd from the whole wallet (including the XYK side's
  // sBTC), without the rebalance swaps; the withdrawn USDCx beyond $100 stays loose.
  confirm(chain.broadcasts[0].txid!);
  chain.nonce = { safe: true };
  chain.plan = [ok];
  const r3 = await cycle(await load());
  assert.equal(r3.res!.action, "open");
  assert.equal(count(WD), 1);
  assert.deepEqual(fns(), [WD, ADD]);
  assert.equal(adds()[0].x, 100_000n); // $100 of sBTC, taken from the XYK side's sBTC
  assert.equal(adds()[0].y, 100_000_000n);
});

test("withdraw confirmed but the result is unparsable -> falls back to the position read for the pending amounts", async () => {
  outOfRange(50_000_000n);
  chain.plan = [{ status: "success", repr: "(ok true)" }];
  touchKillOnFirstSwapPlan();
  const r = await cycle(await load());
  assert.equal(r.res!.alert, true);
  const p = pending()!;
  assert.equal(BigInt(p.xBase), 0n);
  assert.equal(BigInt(p.yBase), withdrawnY(50_000_000n));
});

// Engage KILL the first time the DefiLlama price is read (the swap-planning read inside the
// re-add loop), i.e. after the withdraw has confirmed and the pending re-add is saved.
function touchKillOnFirstSwapPlan() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).includes("coins.llama.fi")) { touchKill(); globalThis.fetch = realFetch; }
    return realFetch(input, init);
  }) as typeof fetch;
}

test("KILL engaged while the withdraw confirms -> no swap or add broadcast; pending saved with the exact withdrawn amounts; resumes once cleared", async () => {
  outOfRange(50_000_000n);
  chain.plan = [ok];
  chain.onPoll = (txid) => { if (chain.txs.get(txid)?.fn === WD) touchKill(); };
  const r = await cycle(await load());
  assert.deepEqual(fns(), [WD]);
  assert.equal(r.res!.alert, true);
  assert.equal(r.res!.skipped, true);
  assert.match(r.res!.reason, /kill switch engaged before rebalance swap/);
  assert.deepEqual(streakEffect(r), { attempted: false, executed: false, tickFailed: true });
  const p = pending()!;
  assert.equal(p.pair, "sbtc-usdcx");
  assert.equal(BigInt(p.xBase), 0n);
  assert.equal(BigInt(p.yBase), withdrawnY(50_000_000n));
  assert.equal(p.abortedSwaps, 0);
  assert.equal(p.pendingSwap, undefined);
  assert.deepEqual(p.before, { x: 0, y: 350 });
  assert.equal(chain.depositsCleared, 1);

  // Still killed after a restart: the resume is skipped before any read-then-broadcast.
  chain.onPoll = undefined;
  const r2 = await cycle(await load());
  assert.match(r2.res!.reason, /kill switch engaged — pending re-add not resumed/);
  assert.deepEqual(fns(), [WD]);

  // KILL cleared, restart: one swap, one add, no second withdraw.
  clearKill();
  chain.plan = [ok, ok];
  const r3 = await cycle(await load());
  assert.equal(r3.res!.executed, true);
  assert.equal(r3.res!.reason, "recentered");
  assert.deepEqual(fns(), [WD, SWAP_YX, ADD]);
  const swap = chain.broadcasts[1];
  assert.equal(swap.amountIn, 175_000_000n); // half of $350
  const e = expectReadd(ownX() + adds()[0].x, withdrawnY(50_000_000n) - 175_000_000n);
  assert.equal(adds()[0].x, e.x);
  assert.equal(adds()[0].y, e.y);
  assert.equal(pending(), null);
  assert.deepEqual(streakEffect(r3), { attempted: true, executed: true, tickFailed: false });
});

// ---- the full recenter and its swaps ----------------------------------------------------------

test("recenter happy path: withdraw -> 1 swap -> re-add of exactly the position's own tokens (98%), centred on the new active bin", async () => {
  outOfRange(50_000_000n);
  chain.plan = [ok, ok, ok];
  const r = await cycle(await load());
  assert.equal(r.res!.executed, true);
  assert.equal(r.res!.reason, "recentered");
  assert.deepEqual(fns(), [WD, SWAP_YX, ADD]);
  assert.equal(r.res!.withdrawTxid, chain.broadcasts[0].txid);
  assert.equal(r.res!.addTxid, chain.broadcasts[2].txid);
  const add = adds()[0];
  // own sBTC before the add = the swap's fill
  const fillX = 175_000n - (175_000n * 30n) / 10_000n;
  assert.deepEqual({ x: add.x, y: add.y }, expectReadd(fillX, 175_000_000n));
  assert.deepEqual(add.bins, [7, 8, 9, 10, 11, 12, 13]);
  assert.equal(chain.sbtc, XYK_SBTC + fillX - add.x, "the XYK side's sBTC is untouched");
  // the swap's min-out: 1% under the better of pool and reference
  assert.equal(chain.broadcasts[1].minOut, 173_250n);
  assert.equal(pending(), null);
  assert.equal(chain.basis.length, 1, "basis adjusted for the resize");
  assert.deepEqual(chain.depositsRecorded, [add.txid]);
});

test("price fell through the position (all sBTC) -> withdraw -> x-for-y swap -> re-add of the position's own tokens", async () => {
  chain.position = positionAround(0, 3, 50_000n, 0n); // 350,000 sats = $350
  chain.activeBin = -10;
  chain.sbtc = XYK_SBTC;
  chain.plan = [ok, ok, ok];
  const r = await cycle(await load());
  assert.equal(r.res!.executed, true);
  assert.deepEqual(fns(), [WD, SWAP_XY, ADD]);
  const swap = chain.broadcasts[1];
  assert.equal(swap.amountIn, 175_000n);
  const out = 175_000_000n - (175_000_000n * 30n) / 10_000n;
  assert.deepEqual({ x: adds()[0].x, y: adds()[0].y }, expectReadd(175_000n, out));
  assert.equal(chain.sbtc, XYK_SBTC + 175_000n - adds()[0].x, "the XYK side's sBTC is untouched");
});

for (const failAt of [1, 2, 3]) {
  test(`swap ${failAt} of 3 aborts -> no add, alert (not a failed add), pending holds the ${failAt - 1} earlier fill(s); the next cycle finishes with one add`, async () => {
    outOfRange(500_000_000n);
    chain.plan = [ok, ...Array(failAt - 1).fill(ok), { status: "abort_by_response" }];
    const r = await cycle(await load());
    assert.deepEqual(fns(), [WD, ...Array(failAt).fill(SWAP_YX)]);
    assert.equal(r.res!.alert, true);
    assert.equal(r.res!.skipped, true);
    assert.match(r.res!.reason, /re-add pending: rebalance swap abort_by_response/);
    assert.deepEqual(streakEffect(r), { attempted: false, executed: false, tickFailed: true });
    const p = pending()!;
    assert.equal(p.abortedSwaps, 1);
    assert.equal(p.pendingSwap, undefined);
    const filledIn = chain.broadcasts.slice(1, failAt).reduce((s, b) => s + b.amountIn!, 0n);
    assert.equal(BigInt(p.yBase), withdrawnY(500_000_000n) - filledIn);
    assert.equal(BigInt(p.xBase), ownX(), "x = exactly the fills received");

    chain.plan = Array(4).fill(ok);
    const r2 = await cycle(await load());
    assert.equal(r2.res!.executed, true);
    assert.equal(count(WD), 1);
    assert.equal(count(ADD), 1);
    assert.equal(pending(), null);
    const yIn = chain.broadcasts.filter((b) => b.fn === SWAP_YX && chain.txs.get(b.txid!)!.status === "success").reduce((s, b) => s + b.amountIn!, 0n);
    const xOwn = ownX() + adds()[0].x;
    assert.deepEqual({ x: adds()[0].x, y: adds()[0].y }, expectReadd(xOwn, withdrawnY(500_000_000n) - yIn));
  });
}

test("three swaps abort in a row (across cycles) -> stops retrying until a human acts; no further broadcast", async () => {
  outOfRange(50_000_000n);
  chain.plan = [ok, { status: "abort_by_response" }];
  await cycle(await load());
  chain.plan = [{ status: "abort_by_response" }];
  await cycle(await load());
  chain.plan = [{ status: "abort_by_post_condition" }];
  await cycle(await load());
  assert.equal(pending()!.abortedSwaps, 3);
  assert.deepEqual(fns(), [WD, SWAP_YX, SWAP_YX, SWAP_YX]);
  const r = await cycle(await load());
  assert.deepEqual(fns(), [WD, SWAP_YX, SWAP_YX, SWAP_YX], "no fourth swap");
  assert.equal(r.res!.alert, true);
  assert.match(r.res!.reason, /3 rebalance swaps failed in a row; not retrying until a human checks/);
  assert.deepEqual(streakEffect(r), { attempted: false, executed: false, tickFailed: true });
});

test("a successful swap resets the aborted-swap count", async () => {
  outOfRange(500_000_000n);
  chain.plan = [ok, { status: "abort_by_response" }];
  await cycle(await load());
  chain.plan = [{ status: "abort_by_response" }];
  await cycle(await load());
  assert.equal(pending()!.abortedSwaps, 2);
  chain.plan = [ok, { status: "abort_by_response" }];
  await cycle(await load());
  assert.equal(pending()!.abortedSwaps, 1);
});

test("swap broadcast rejected (throws) -> recenterOnce throws (counted as a failed attempt); pending unchanged, resumed next cycle", async () => {
  outOfRange(50_000_000n);
  chain.plan = [ok, { throws: "broadcast failed: TooMuchChaining" }];
  const r = await cycle(await load());
  assert.match(r.error!.message, /TooMuchChaining/);
  assert.deepEqual(streakEffect(r), { attempted: true, executed: false, tickFailed: true });
  const p = pending()!;
  assert.equal(BigInt(p.yBase), withdrawnY(50_000_000n));
  assert.equal(p.abortedSwaps, 0);
  assert.equal(p.pendingSwap, undefined);
  chain.plan = [ok, ok];
  const r2 = await cycle(await load());
  assert.equal(r2.res!.executed, true);
  assert.deepEqual(fns(), [WD, SWAP_YX, SWAP_YX, ADD]);
});

test("restart mid-swaps: swap 2 of 3 times out -> pending records its txid; resumed only once it settles, applying its fill exactly once", async () => {
  outOfRange(500_000_000n);
  chain.plan = [ok, ok, { status: "timeout" }];
  const r = await cycle(await load());
  assert.equal(r.res!.alert, true);
  assert.match(r.res!.reason, /not confirmed yet; it will be settled next cycle/);
  const swap2 = chain.broadcasts[2];
  let p = pending()!;
  assert.deepEqual(p.pendingSwap, { txid: swap2.txid, direction: "y-for-x" });
  assert.equal(BigInt(p.yBase), withdrawnY(500_000_000n) - chain.broadcasts[1].amountIn!, "only swap 1 applied");

  // Restart, swap 2 still in the mempool: the nonce gate holds the cycle.
  chain.nonce = { safe: false, reason: "a prior tx is still pending in the mempool (1 nonce)" };
  const r2 = await cycle(await load());
  assert.equal(r2.res!.skipped, true);
  assert.equal(chain.broadcasts.length, 3);
  // Nonce gate clear (e.g. the indexer dropped it from the mempool view) but the tx still reads
  // pending: still no new swap, no add.
  chain.nonce = { safe: true };
  const r3 = await cycle(await load());
  assert.match(r3.res!.reason, /earlier rebalance swap .* still unconfirmed/);
  assert.equal(chain.broadcasts.length, 3);

  // It confirms: the fill is applied once, then swap 3 and the add.
  confirm(swap2.txid!);
  chain.plan = [ok, ok];
  const r4 = await cycle(await load());
  assert.equal(r4.res!.executed, true);
  assert.deepEqual(fns(), [WD, SWAP_YX, SWAP_YX, SWAP_YX, ADD]);
  const yIn = chain.broadcasts.filter((b) => b.fn === SWAP_YX).reduce((s, b) => s + b.amountIn!, 0n);
  assert.deepEqual({ x: adds()[0].x, y: adds()[0].y }, expectReadd(ownX() + adds()[0].x, withdrawnY(500_000_000n) - yIn));
  assert.equal(pending(), null);
});

test("restart mid-swaps: a timed-out swap that later ABORTS counts as one failed swap and is retried", async () => {
  outOfRange(50_000_000n);
  chain.plan = [ok, { status: "timeout" }];
  await cycle(await load());
  confirm(chain.broadcasts[1].txid!, "abort_by_response");
  chain.plan = [ok, ok];
  const r = await cycle(await load());
  assert.equal(r.res!.executed, true);
  assert.deepEqual(fns(), [WD, SWAP_YX, SWAP_YX, ADD]);
  // the aborted swap moved nothing: the add is the second swap's fill and the rest of the USDCx
  assert.deepEqual({ x: adds()[0].x, y: adds()[0].y }, expectReadd(ownX() + adds()[0].x, withdrawnY(50_000_000n) - chain.broadcasts[2].amountIn!));
});

test("more than 6 swaps needed -> stops after 6 (alert), pending holds all 6 fills; the next cycle finishes", async () => {
  outOfRange(1_430_000_000n); // ~$10,010
  chain.plan = [ok, ...Array(6).fill(ok)];
  const r = await cycle(await load());
  assert.deepEqual(fns(), [WD, ...Array(6).fill(SWAP_YX)]);
  assert.equal(r.res!.alert, true);
  assert.match(r.res!.reason, /still not balanced after 6 swaps this cycle/);
  for (const b of chain.broadcasts.slice(1)) assert.equal(b.amountIn, 600_000_000n, "each chunk is capped at $600");
  const p = pending()!;
  assert.equal(BigInt(p.yBase), withdrawnY(1_430_000_000n) - 6n * 600_000_000n);
  assert.equal(BigInt(p.xBase), ownX());
  chain.plan = [ok, ok];
  const r2 = await cycle(await load());
  assert.equal(r2.res!.executed, true);
  assert.equal(count(SWAP_YX), 7);
  assert.equal(count(ADD), 1);
  assert.equal(count(WD), 1);
});

test("KILL engaged between swaps -> the next swap is not broadcast; pending holds the fills so far", async () => {
  outOfRange(500_000_000n);
  chain.plan = [ok, ok, ok];
  let swapsSeen = 0;
  chain.onPoll = (txid) => { if (chain.txs.get(txid)?.fn === SWAP_YX && ++swapsSeen === 2) touchKill(); };
  const r = await cycle(await load());
  assert.deepEqual(fns(), [WD, SWAP_YX, SWAP_YX]);
  assert.match(r.res!.reason, /kill switch engaged before rebalance swap/);
  const yIn = chain.broadcasts.slice(1).reduce((s, b) => s + b.amountIn!, 0n);
  assert.equal(BigInt(pending()!.yBase), withdrawnY(500_000_000n) - yIn);
  assert.equal(BigInt(pending()!.xBase), ownX());
});

test("reference price down or pool diverged during the rebalance -> wait (alert), no swap", async () => {
  outOfRange(50_000_000n);
  chain.plan = [ok];
  chain.btcUsd = null;
  const r = await cycle(await load());
  assert.deepEqual(fns(), [WD]);
  assert.match(r.res!.reason, /reference price unavailable/);
  chain.btcUsd = BTC_USD * 1.05; // pool 476 bps below the reference
  const r2 = await cycle(await load());
  assert.deepEqual(fns(), [WD]);
  assert.match(r2.res!.reason, /pool \d+bps from the reference/);
  assert.equal(r2.res!.alert, true);
});

// ---- re-add ---------------------------------------------------------------------------------

test("re-add aborts -> alert with the add txid; pending kept with the same amounts; next cycle re-adds exactly once", async () => {
  outOfRange(50_000_000n);
  chain.plan = [ok, ok, { status: "abort_by_response" }];
  const r = await cycle(await load());
  assert.equal(r.res!.alert, true);
  assert.equal(r.res!.executed, false);
  assert.match(r.res!.reason, /re-add pending: re-add abort_by_response/);
  assert.equal(r.res!.addTxid, chain.broadcasts[2].txid);
  assert.deepEqual(streakEffect(r), { attempted: false, executed: false, tickFailed: true });
  const p = pending()!;
  const firstAdd = adds()[0];
  chain.plan = [ok];
  const r2 = await cycle(await load());
  assert.equal(r2.res!.executed, true);
  assert.deepEqual(fns(), [WD, SWAP_YX, ADD, ADD]);
  assert.deepEqual({ x: adds()[1].x, y: adds()[1].y }, { x: firstAdd.x, y: firstAdd.y }, "same amounts");
  assert.deepEqual(expectReadd(BigInt(p.xBase), BigInt(p.yBase)), { x: firstAdd.x, y: firstAdd.y });
  assert.equal(pending(), null);
});

test("re-add times out then confirms -> next cycle sees the position, discards the pending record, no second add", async () => {
  outOfRange(50_000_000n);
  chain.plan = [ok, ok, { status: "timeout" }];
  const r = await cycle(await load());
  assert.match(r.res!.reason, /re-add timeout/);
  assert.notEqual(pending(), null);
  confirm(adds()[0].txid!);
  const r2 = await cycle(await load());
  assert.equal(r2.res!.action, "hold");
  assert.equal(count(ADD), 1);
  assert.equal(pending(), null);
});

test("re-add times out and is still unconfirmed on restart -> the nonce gate holds; no second add (the add txid is not persisted)", async () => {
  outOfRange(50_000_000n);
  chain.plan = [ok, ok, { status: "timeout" }];
  await cycle(await load());
  assert.equal(pending()!.pendingSwap, undefined, "unlike a swap, a timed-out re-add leaves no txid in the pending record");
  chain.nonce = { safe: false, reason: "a prior tx is still pending in the mempool (1 nonce)" };
  const r = await cycle(await load());
  assert.equal(r.res!.skipped, true);
  assert.equal(count(ADD), 1);
});

test("restart before the re-add: price source down when sizing the add -> throws (failed attempt), pending kept, next cycle adds once", async () => {
  // Balanced pending (as if every swap had settled), the price feed fails at the add.
  writePending({ xBase: 175_000n, yBase: 175_000_000n });
  chain.sbtc = XYK_SBTC + 175_000n;
  chain.usdcx = 175_000_000n;
  chain.activeBin = 10;
  chain.btcUsd = null;
  const r = await cycle(await load());
  assert.match(r.error!.message, /could not read BTC price|price source down/);
  assert.deepEqual(fns(), []);
  assert.deepEqual(streakEffect(r), { attempted: true, executed: false, tickFailed: true });
  assert.equal(BigInt(pending()!.xBase), 175_000n);
  chain.btcUsd = BTC_USD;
  chain.plan = [ok];
  const r2 = await cycle(await load());
  assert.equal(r2.res!.executed, true);
  assert.deepEqual(fns(), [ADD]);
  assert.deepEqual({ x: adds()[0].x, y: adds()[0].y }, expectReadd(175_000n, 175_000_000n));
});

test("re-add with the wallet short of the recorded amounts (indexer lag) -> capped to the real balance, never more", async () => {
  writePending({ xBase: 175_000n, yBase: 175_000_000n });
  chain.sbtc = 100_000n; // less than recorded, and no XYK sBTC
  chain.usdcx = 175_000_000n;
  chain.activeBin = 10;
  chain.plan = [ok];
  const r = await cycle(await load());
  assert.equal(r.res!.executed, true);
  assert.equal(adds()[0].x, 100_000n);
  assert.equal(adds()[0].y, expectReadd(0n, 175_000_000n).y);
});

test("DLMM_MAX_TARGET_USD caps the re-add (TODAY'S behaviour): scaled down proportionally, the rest stays loose in the wallet and the pending record is cleared", async () => {
  delete process.env.DLMM_MAX_TARGET_USD; // default $250
  writePending({ xBase: 500_000n, yBase: 500_000_000n }); // $1,000 withdrawn
  chain.sbtc = 500_000n;
  chain.usdcx = 500_000_000n;
  chain.activeBin = 10;
  chain.plan = [ok];
  const r = await cycle(await load());
  assert.equal(r.res!.executed, true);
  const add = adds()[0];
  const valueUsd = (Number(add.x) / 1e8) * BTC_USD + Number(add.y) / 1e6;
  assert.ok(valueUsd <= 250 && valueUsd > 249.9, `re-add value $${valueUsd}`);
  // proportional: $980 (98%) scaled by 250/980
  assert.equal(add.x, BigInt(Math.floor(490_000 * (250 / 980))));
  assert.equal(pending(), null, "the excess is not tracked as pending");
  assert.equal(chain.sbtc, 500_000n - add.x);
});

test("a targetUsd above DLMM_MAX_TARGET_USD fails the re-add AFTER the withdraw (TODAY'S behaviour): throws, pending kept", async () => {
  delete process.env.DLMM_MAX_TARGET_USD;
  outOfRange(50_000_000n);
  chain.plan = [ok, ok];
  const r = await cycle(await load(), { cfg: { targetUsd: 300 } });
  assert.match(r.error!.message, /target must be >0 and ≤ 250/);
  assert.deepEqual(fns(), [WD, SWAP_YX]);
  assert.notEqual(pending(), null);
});

// ---- resume edge cases ------------------------------------------------------------------------

test("pending record for another pair is ignored", async () => {
  writePending({ pair: "stx-usdcx", xBase: 1n, yBase: 1n });
  chain.position = positionAround(0, 3, 10_000n, 10_000_000n);
  const r = await cycle(await load());
  assert.equal(r.res!.action, "hold");
  assert.equal(pending()!.pair, "stx-usdcx");
});

test("pending record but a position exists again -> record discarded; never a withdraw of the new position in the same breath unless it is out of range", async () => {
  writePending({ xBase: 175_000n, yBase: 175_000_000n });
  chain.position = positionAround(0, 3, 10_000n, 10_000_000n);
  const r = await cycle(await load());
  assert.equal(r.res!.action, "hold");
  assert.deepEqual(fns(), []);
  assert.equal(pending(), null);
});

test("observe mode with a pending re-add -> not resumed, nothing broadcast, record kept", async () => {
  writePending({ xBase: 175_000n, yBase: 175_000_000n });
  const r = await cycle(await load(), { live: false });
  assert.match(r.res!.reason, /pending re-add \(observe: not resumed\)/);
  assert.deepEqual(fns(), []);
  assert.notEqual(pending(), null);
});

test("a corrupt pending file reads as no pending (TODAY'S behaviour): an empty position then takes the open path", async () => {
  mkdirSync(dirname(PENDING_PATH), { recursive: true });
  writeFileSync(PENDING_PATH, "{not json");
  chain.sbtc = 1_000_000n;
  chain.usdcx = 500_000_000n;
  const r = await cycle(await load(), { live: false });
  assert.equal(r.res!.action, "open");
});
