// Fault-injection harness for the DLMM recenter orchestrator, src/m1/dlmm-recenter-exec.ts
// (B5 / DSA-14).
//
// recenterOnce() is open / hold / recenter = withdraw -> up to 6 chunked rebalance swaps ->
// re-add, with the pending re-add persisted between cycles. This harness replaces every I/O
// edge with a small simulated chain (`chain`) so a test can fail any step and then "restart"
// the process (a fresh module instance, state files kept) and check the resume:
//
//   - dlmm-execute.executeDescriptor (the only DLMM broadcast) is a fake that records each call
//     (function, decoded amounts, and whether KILL was engaged at that moment) and consumes the
//     next scripted outcome from chain.plan: success / an abort status / "timeout" (stays
//     pending) / a thrown broadcast error. A confirmed tx changes the simulated wallet and
//     position the way the real one would (withdraw -> wallet, swap -> fill at the pool price,
//     add -> position);
//   - DLMM reads (pool state, bin states, share floors, local depth, user position), the
//     wallet's native STX balance, the nonce gate, fetchNonce and the get-decimals read are
//     fakes driven by `chain`;
//   - global fetch answers only: tx status (from chain.txs), FT balances, the token interface,
//     and the DefiLlama price; anything else throws, so an unmocked path fails the test;
//   - metrics (basis), deposit tracking (dlmm-fees, dlmm-fees-record) are recording fakes;
//   - kill.ts and dlmm-pending-state.ts are REAL, on a per-process temp dir (APP_DIR,
//     DLMM_PENDING_STATE_PATH).
//
// Pool: sbtc-usdcx (x = sBTC, 8 dp; y = USDCx, 6 dp), BTC = $100,000, so 1 sat = $0.001 =
// 1,000 USDCx base units.
// setTimeout is mocked while a cycle runs, so the 6 s confirmation polls run instantly.

import { mock } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- environment, before the module under test is loaded ------------------------------------
export const TMP = mkdtempSync(join(tmpdir(), "deepstack-dlmm-harness-"));
const ENV_CLEARED = [
  "KILL_SWITCH", "DLMM_PIN_HALF_WIDTH", "DLMM_MAX_TARGET_USD", "DLMM_MAX_POOL_SHARE_BPS",
  "DLMM_REBALANCE_SLIPPAGE_BPS", "DLMM_REBALANCE_MAX_DIVERGENCE_BPS", "DLMM_REBALANCE_CHUNK_VALUE_Y",
];
export const APP_DIR = join(TMP, "app");
export const PENDING_PATH = join(TMP, "journal", "dlmm-pending-readd.json");
function resetEnv(): void {
  for (const k of ENV_CLEARED) delete process.env[k];
  process.env.APP_DIR = APP_DIR;
  process.env.DLMM_PENDING_STATE_PATH = PENDING_PATH;
  process.env.STACKS_API = "https://rpc.invalid";
  process.env.STACKS_API_FALLBACKS = "";
}
resetEnv();
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

export const KILL_FILE = join(APP_DIR, "KILL");
export function touchKill(): void {
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(KILL_FILE, "");
}
export function clearKill(): void {
  rmSync(KILL_FILE, { force: true });
}

// ---- the simulated chain ---------------------------------------------------------------------
export const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
export const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const CORE = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
export const SBTC_ASSET = `${SBTC}::sbtc-token`;
export const USDCX_ASSET = `${USDCX}::usdcx-token`;
// PRICE: the core's bin price is y-base per x-base x 1e8. $100,000 per BTC = 1e11 USDCx base
// per 1e8 sats = 1,000 USDCx base per sat -> 1,000 x 1e8 = 1e11.
export const BTC_USD = 100_000;
export const BIN_PRICE = 100_000_000_000n;
export const POOL_FEE_BPS = 30n; // simulated fill: pool price less 0.3%

export interface Step {
  status?: string; // "success" | an abort status | "timeout" (stays pending until confirm())
  repr?: string; // override the Clarity result the simulated chain would produce
  throws?: string; // the broadcast itself throws (rejected by the node, no txid)
}
export interface Bin { signedBin: number; userShares: bigint; userX: bigint; userY: bigint }
export interface Tx { status: string; repr?: string; fn: string; apply?: () => void }
export interface Broadcast {
  fn: string; // withdraw-liquidity-multi | swap-x-for-y-simple-multi | swap-y-for-x-simple-multi | add-liquidity-multi
  killed: boolean; // isKilled() at the moment of the broadcast — must never be true
  txid?: string;
  x: bigint; // add: summed x-amount; swap: amountIn when x-for-y; withdraw: 0
  y: bigint;
  amountIn?: bigint;
  minOut?: bigint;
  bins?: number[];
  opts: Record<string, unknown>;
}

export interface Chain {
  activeBin: number;
  binPrice: bigint; // price the pool reports for every bin (and fills swaps at)
  position: Bin[];
  sbtc: bigint; // wallet FT balances, base units
  usdcx: bigint;
  stx: bigint; // native, micro
  btcUsd: number | null; // DefiLlama; null = the price fetch fails
  priceAgeSecs: number; // age of the DefiLlama price (its timestamp field)
  nonce: { safe: boolean; reason?: string };
  plan: Step[]; // outcomes for the next broadcasts, in order
  txs: Map<string, Tx>;
  broadcasts: Broadcast[];
  basis: { xQty: number; yQty: number; t: string }[]; // setDlmmBasis calls
  depositsRecorded: string[];
  depositsCleared: number;
  fetches: string[];
  /** Hook run at the start of every tx-status poll for txid (e.g. engage KILL mid-wait). */
  onPoll?: (txid: string) => void;
}
export let chain: Chain = freshChain();
function freshChain(): Chain {
  return {
    activeBin: 0, binPrice: BIN_PRICE, position: [], sbtc: 0n, usdcx: 0n, stx: 500_000_000n,
    btcUsd: BTC_USD, priceAgeSecs: 30, nonce: { safe: true }, plan: [], txs: new Map(), broadcasts: [], basis: [],
    depositsRecorded: [], depositsCleared: 0, fetches: [],
  };
}
let txn = 0;
export function resetChain(c: Partial<Chain> = {}): Chain {
  chain = { ...freshChain(), ...c };
  resetEnv();
  clearKill();
  rmSync(PENDING_PATH, { force: true });
  return chain;
}

/** Settle a tx left "timeout"/pending: set its final status and apply its effect on success. */
export function confirm(txid: string, status = "success"): void {
  const t = chain.txs.get(txid);
  if (!t) throw new Error(`no tx ${txid}`);
  t.status = status;
  if (status === "success") t.apply?.();
  else t.repr = "(err u5001)";
}

/** A position of `n` bins centred on `center`, each holding (x, y). */
export function positionAround(center: number, half: number, x: bigint, y: bigint): Bin[] {
  const bins: Bin[] = [];
  for (let b = center - half; b <= center + half; b++) bins.push({ signedBin: b, userShares: 1_000_000n, userX: x, userY: y });
  return bins;
}
export const posTotals = () => chain.position.reduce((s, b) => ({ x: s.x + b.userX, y: s.y + b.userY }), { x: 0n, y: 0n });

// Fill a swap at the pool's price less the pool fee (base units, floor).
function fill(direction: "x-for-y" | "y-for-x", amountIn: bigint): bigint {
  const gross = direction === "x-for-y" ? (amountIn * chain.binPrice) / 100_000_000n : (amountIn * 100_000_000n) / chain.binPrice;
  return (gross * (10_000n - POOL_FEE_BPS)) / 10_000n;
}

// ---- decoding the descriptors the orchestrator built -------------------------------------
type CV = { type: string; value: any };
const u = (cv: CV) => BigInt(cv.value);
function decode(d: { functionName: string; functionArgs: CV[] }): Omit<Broadcast, "killed" | "opts" | "txid"> {
  const fn = d.functionName;
  if (fn === "add-liquidity-multi" || fn === "withdraw-liquidity-multi") {
    const list = d.functionArgs[0].value as { value: Record<string, CV> }[];
    const bins = list.map((t) => Number(t.value["bin-id"].value));
    if (fn === "withdraw-liquidity-multi") return { fn, x: 0n, y: 0n, bins };
    return {
      fn, bins,
      x: list.reduce((s, t) => s + u(t.value["x-amount"]), 0n),
      y: list.reduce((s, t) => s + u(t.value["y-amount"]), 0n),
    };
  }
  const amountIn = u(d.functionArgs[3]);
  const minOut = u(d.functionArgs[4]);
  return fn === "swap-x-for-y-simple-multi"
    ? { fn, x: amountIn, y: 0n, amountIn, minOut }
    : { fn, x: 0n, y: amountIn, amountIn, minOut };
}

// ---- module mocks --------------------------------------------------------------------------
const { isKilled } = await import("./kill.js");
const realTx = await import("@stacks/transactions");
const { Cl } = realTx;

mock.module("./dlmm-execute.js", {
  namedExports: {
    canBroadcast: (o: { live?: boolean; yesMainnet?: boolean }) => o.live === true && o.yesMainnet === true,
    executeDescriptor: async (d: { functionName: string; functionArgs: CV[] }, opts: Record<string, unknown>) => {
      const b: Broadcast = { ...decode(d), killed: isKilled(), opts };
      chain.broadcasts.push(b);
      const step = chain.plan.shift();
      if (!step) throw new Error(`harness: no scripted outcome for broadcast #${chain.broadcasts.length} (${d.functionName})`);
      if (step.throws) throw new Error(step.throws);
      const txid = `0x${(++txn).toString(16).padStart(4, "0")}`;
      b.txid = txid;
      const tx: Tx = { status: step.status === "timeout" ? "pending" : (step.status ?? "success"), fn: b.fn };
      // What the confirmed tx does on the simulated chain, and its Clarity result.
      if (b.fn === "withdraw-liquidity-multi") {
        const t = posTotals();
        const each = chain.position.map((p) => `(tuple (x-amount u${p.userX}) (y-amount u${p.userY}))`).join(" ");
        tx.repr = step.repr ?? `(ok (list ${each}))`;
        tx.apply = () => { chain.sbtc += t.x; chain.usdcx += t.y; chain.position = []; };
      } else if (b.fn.startsWith("swap-")) {
        const dir = b.fn === "swap-x-for-y-simple-multi" ? "x-for-y" : "y-for-x";
        const out = fill(dir, b.amountIn!);
        if ((step.status ?? "success") === "success" && out < b.minOut!) throw new Error(`harness: simulated fill ${out} below min-out ${b.minOut}`);
        tx.repr = step.repr ?? `(ok (tuple (in u${b.amountIn}) (out u${out})))`;
        tx.apply = () => {
          if (dir === "x-for-y") { chain.sbtc -= b.amountIn!; chain.usdcx += out; }
          else { chain.usdcx -= b.amountIn!; chain.sbtc += out; }
        };
      } else {
        const bins = b.bins!;
        tx.repr = step.repr ?? "(ok (list))";
        tx.apply = () => {
          chain.sbtc -= b.x; chain.usdcx -= b.y;
          // deposit spread evenly over the bins (good enough for totals)
          const n = BigInt(bins.length);
          chain.position = bins.map((sb) => ({ signedBin: sb, userShares: 1_000_000n, userX: b.x / n, userY: b.y / n }));
        };
      }
      if (tx.status === "success") tx.apply!();
      if (tx.status !== "success" && tx.status !== "pending" && !step.repr) tx.repr = "(err u5001)";
      chain.txs.set(txid, tx);
      return { broadcast: true, dryRun: false, txid, summary: `harness ${b.fn}` };
    },
  },
});

mock.module("@stacks/transactions", {
  namedExports: {
    ...realTx,
    fetchNonce: async () => 7n,
    // Only resolveToken's get-decimals reaches this (the DLMM reads are faked below).
    fetchCallReadOnlyFunction: async (o: { contractName: string; functionName: string }) => {
      if (o.functionName !== "get-decimals") throw new Error(`harness: unexpected read-only ${o.contractName}.${o.functionName}`);
      return Cl.ok(Cl.uint(o.contractName === "sbtc-token" ? 8 : 6));
    },
    makeContractCall: async () => { throw new Error("harness: makeContractCall must not be reached"); },
    broadcastTransaction: async () => { throw new Error("harness: broadcastTransaction must not be reached"); },
  },
});

const realRpc = await import("./rpc.js");
mock.module("./rpc.js", {
  namedExports: {
    ...realRpc,
    withRpc: async <T>(fn: (base: string) => Promise<T>) => fn("https://rpc.invalid"),
    hiroFetch: () => globalThis.fetch,
  },
});

const realWallet = await import("./wallet.js");
mock.module("./wallet.js", {
  namedExports: { ...realWallet, getStxBalance: async () => ({ stx: Number(chain.stx) / 1e6, microStx: chain.stx }) },
});

const realRead = await import("./dlmm-read.js");
mock.module("./dlmm-read.js", {
  namedExports: {
    ...realRead, // DLMM_POOLS and pinMismatch stay real
    readDlmmState: async (pool: { key: string }) => ({
      pool: pool.key, activeBinId: chain.activeBin, binStep: 10, xToken: SBTC, yToken: USDCX, coreAddress: CORE,
      binChangeCount: 0, initialPrice: 100_000_000n,
    }),
    readBinLiquidityStates: async (_p: unknown, _c: string, _i: bigint, _s: number, bins: number[]) =>
      new Map(bins.map((b) => [b, { xBalance: 1_000_000_000n, yBalance: 1_000_000_000_000n, binShares: 2_000_000_000_000n, binPrice: chain.binPrice }])),
    readShareFloors: async () => ({ minBinShares: 10_000n, minBurntShares: 1_000n }),
    readLocalDepth: async (_p: unknown, activeBinId: number, halfWindow: number) => ({
      activeBinId, halfWindow, xTotal: 10_000_000_000n, yTotal: 10_000_000_000_000n, binsWithLiquidity: 2 * halfWindow + 1, binsSkipped: 0,
    }),
  },
});

const realPos = await import("./dlmm-position.js");
mock.module("./dlmm-position.js", {
  namedExports: {
    ...realPos,
    readUserPosition: async (pool: { key: string }, user: string) => {
      const bins = [...chain.position].sort((a, b) => a.signedBin - b.signedBin);
      const t = posTotals();
      return {
        pool: pool.key, user, bins,
        lowerSignedBin: bins.length ? bins[0].signedBin : null, upperSignedBin: bins.length ? bins[bins.length - 1].signedBin : null,
        totalX: t.x, totalY: t.y,
      };
    },
  },
});

const realNonce = await import("./nonce-safety.js");
mock.module("./nonce-safety.js", {
  namedExports: { ...realNonce, checkNonceSafety: async () => ({ missingNonces: [], mempoolPending: 0, ...chain.nonce }) },
});

const realMetrics = await import("./metrics.js");
mock.module("./metrics.js", {
  namedExports: {
    ...realMetrics,
    loadHistory: () => [],
    loadVenueBases: () => ({ dlmmBasis: { xQty: 0.001, yQty: 100, t: "2026-11-01T00:00:00Z" } }),
    setDlmmBasis: (b: { xQty: number; yQty: number; t: string }) => void chain.basis.push(b),
  },
});
const realFees = await import("./dlmm-fees.js");
mock.module("./dlmm-fees.js", { namedExports: { ...realFees, clearDeposit: () => void chain.depositsCleared++ } });
mock.module("./dlmm-fees-record.js", {
  namedExports: { recordDepositFromTx: async (txid: string) => { chain.depositsRecorded.push(txid); return true; } },
});

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input instanceof Request ? input.url : input);
  chain.fetches.push(url);
  let m = /\/extended\/v1\/tx\/(0x[0-9a-f]+)$/.exec(url);
  if (m) {
    chain.onPoll?.(m[1]);
    const t = chain.txs.get(m[1]);
    if (!t) return new Response("not found", { status: 404 });
    return json({ tx_status: t.status, tx_result: t.status === "pending" ? undefined : { repr: t.repr } });
  }
  if (/\/extended\/v1\/address\/[^/]+\/balances$/.test(url)) {
    return json({ stx: { balance: chain.stx.toString() }, fungible_tokens: { [SBTC_ASSET]: { balance: chain.sbtc.toString() }, [USDCX_ASSET]: { balance: chain.usdcx.toString() } } });
  }
  m = /\/v2\/contracts\/interface\/[^/]+\/([^/]+)$/.exec(url);
  if (m) return json({ fungible_tokens: [{ name: m[1] === "sbtc-token" ? "sbtc-token" : "usdcx-token" }] });
  if (url === "https://coins.llama.fi/prices/current/coingecko:bitcoin") {
    if (chain.btcUsd === null) throw new Error("harness: price source down");
    return json({ coins: { "coingecko:bitcoin": { price: chain.btcUsd, timestamp: Math.floor(Date.now() / 1000) - chain.priceAgeSecs } } });
  }
  throw new Error(`harness: unexpected network call ${url}`);
}) as typeof fetch;

// ---- driving the orchestrator ---------------------------------------------------------------
export type Mod = typeof import("./dlmm-recenter-exec.js");
let instance = 0;
/** A fresh dlmm-recenter-exec module instance (same mocks): what a process restart loads. */
export async function load(): Promise<Mod> {
  return import(`./dlmm-recenter-exec.js?b5=${++instance}`);
}

export const WALLET = { address: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR", key: "unused-throwaway", network: "mainnet" } as const;
export const CFG = { pair: "sbtc-usdcx", halfWidth: 3, targetUsd: 200 };

export interface Run { res?: Awaited<ReturnType<Mod["recenterOnce"]>>; error?: Error; logs: string[] }
/** One recenterOnce cycle with setTimeout mocked, so confirmation polls don't wait. */
export async function cycle(mod: Mod, opts: { live?: boolean; cfg?: Partial<typeof CFG> & Record<string, unknown> } = {}): Promise<Run> {
  const { mock: m } = await import("node:test");
  const run: Run = { logs: [] };
  let settled = false;
  m.timers.enable({ apis: ["setTimeout"] });
  try {
    mod.recenterOnce(WALLET as never, { ...CFG, ...opts.cfg } as never, opts.live ?? true, (s) => void run.logs.push(s)).then(
      (r) => { run.res = r; settled = true; },
      (e: Error) => { run.error = e; settled = true; },
    );
    for (let i = 0; i < 50_000 && !settled; i++) {
      await new Promise((r) => setImmediate(r));
      m.timers.runAll();
    }
    if (!settled) throw new Error("recenterOnce did not settle");
    return run;
  } finally {
    m.timers.reset();
  }
}

/**
 * The fail-streak transition agent-cli.ts applies to a recenterOnce outcome (see its DLMM block:
 * attempted = live && action !== "hold" && !skipped; a throw counts as a failed attempt; alert
 * marks the tick failed for the health check without counting a failed add).
 */
export function streakEffect(run: Run, live = true): { attempted: boolean; executed: boolean; tickFailed: boolean } {
  if (run.error) return { attempted: live, executed: false, tickFailed: live };
  const r = run.res!;
  const attempted = live && r.action !== "hold" && !r.skipped;
  return { attempted, executed: r.executed, tickFailed: (!r.executed && attempted) || !!r.alert };
}

export const fns = () => chain.broadcasts.map((b) => b.fn);
