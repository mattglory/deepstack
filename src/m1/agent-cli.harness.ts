// Test harness for the live orchestrator, src/m1/agent-cli.ts (B4 / DSA-14).
//
// agent-cli.ts wires reads, decisions and broadcasts together inside main(); step() is a
// closure in main(), so the harness drives main() itself, exactly as systemd does, with every
// I/O module replaced through node:test's module mocking (needs --experimental-test-module-mocks,
// set in the package.json test script). Nothing here touches the network or a real key:
//
//   - reads (wallet balances, pool state, external price, nonce check, DLMM reads, tuner,
//     cross-pool scans, funding) are fakes driven by `world`;
//   - XYK builders (actions.ts) are the REAL builders wrapped in a recorder, so the test sees
//     the amount/opts agent-cli passed AND the contract-call args (incl. min-out) the builder
//     derived from them; signing uses a random throwaway key; broadcastTransaction and
//     fetchNonce are fakes, so nothing reaches a node;
//   - flashRebalanceOnce and recenterOnce are recording fakes;
//   - journal / healthcheck / metrics / publish are recording fakes;
//   - kill.ts, safety.ts's assessSafety, agent.ts and the fail-streak/experiment state files are
//     REAL (state files point at a per-process temp dir, KILL at APP_DIR in that dir);
//   - global fetch is replaced by a fake that answers only the tx-status poll and throws on
//     anything else, so an unmocked network path fails the test instead of going out.
//
// Import this module before anything else in a test file, then call loadAgent() for a fresh
// agent-cli instance (its module-level state: tickJournal, rebalDefer, the DLMM value cache)
// and runAgent() to drive main() for N cycles. One test file = one process, so the mocks never
// leak into other test files.

import { mock } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- environment: before any module under test is loaded (some read env at import) ----------
export const TMP = mkdtempSync(join(tmpdir(), "deepstack-agent-harness-"));
const ENV_KEYS_CLEARED = [
  "PAIR", "KILL_SWITCH", "HEALTHCHECK_URL", "METRICS_GIST_ID", "METRICS_GIST_TOKEN", "OPENROUTER_API_KEY",
  "STACKS_PRIVATE_KEY", "STACKS_NETWORK", "FLASH_LIVE", "DLMM_LIVE", "DLMM_OBSERVE_PAIR", "TARGET_LP_FRACTION",
  "ALLOCATION_MODE", "EXPERIMENT_BAND_MODE", "MIN_TRADE_VALUE_Y", "STX_FEE_RESERVE", "EXEC_MIN_EDGE_BPS",
  "EXEC_MAX_DEFER", "MAX_CONSECUTIVE_FAILURES", "DLMM_FAIL_STREAK_LIMIT", "FLASH_FAIL_STREAK_LIMIT",
  "DLMM_HALF_WIDTH", "DLMM_TARGET_USD", "DLMM_PIN_HALF_WIDTH", "MAX_POOL_SHARE_BPS",
];
const ENV_BASE: Record<string, string> = {
  APP_DIR: join(TMP, "app"),
  JOURNAL_DIR: join(TMP, "journal"),
  METRICS_PATH: join(TMP, "metrics.json"),
  CAPITAL_FLOWS_PATH: join(TMP, "capital-flows.json"),
  WALLET_MIGRATIONS_PATH: join(TMP, "wallet-migrations.json"),
  DLMM_FAILSTREAK_STATE_PATH: join(TMP, "dlmm-failstreak.json"),
  FLASH_FAILSTREAK_STATE_PATH: join(TMP, "flash-failstreak.json"),
  XYK_TRADES_STATE_PATH: join(TMP, "xyk-trades.json"),
  DRAWDOWN_BASELINE_PATH: join(TMP, "drawdown-baseline.json"),
  EXPERIMENT_STATE_PATH: join(TMP, "experiment.json"),
  DLMM_DEPOSIT_PATH: join(TMP, "dlmm-deposit.json"),
  STACKS_API: "https://rpc.invalid",
  STACKS_API_FALLBACKS: "",
};
function resetEnv(): void {
  for (const k of ENV_KEYS_CLEARED) delete process.env[k];
  Object.assign(process.env, ENV_BASE);
}
resetEnv();
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

/** Path of the real KILL file the agent checks (kill.ts, via APP_DIR). */
export const KILL_FILE = join(ENV_BASE.APP_DIR, "KILL");
export function touchKill(): void {
  mkdirSync(ENV_BASE.APP_DIR, { recursive: true });
  writeFileSync(KILL_FILE, "");
}

// ---- recorded calls -----------------------------------------------------------------------
export interface BuildCall { fn: string; amount: bigint; opts: Record<string, unknown> }
export interface ContractCall { functionName: string; functionArgs: unknown[]; senderKey: string; network: unknown }
export interface Recorded {
  builds: BuildCall[]; // XYK builder entry points called by agent-cli (actions.ts)
  contractCalls: ContractCall[]; // what those builders signed (makeContractCall args)
  broadcasts: unknown[]; // wire-level broadcastTransaction calls — the last line before mainnet
  flash: { cfg: unknown; live: boolean }[]; // flashRebalanceOnce
  recenter: { cfg: Record<string, unknown>; live: boolean }[]; // recenterOnce
  journal: Record<string, unknown>[]; // appendJournal entries (cloned at write time)
  health: ("ok" | "fail")[]; // pingHealthcheck statuses, one per cycle end (plus supervisor fails)
  nonceChecks: string[]; // checkNonceSafety addresses
  samples: Record<string, unknown>[]; // recordSample metrics samples
  fetches: string[]; // global fetch URLs
  getWallet: number;
  logs: string[]; // console output captured during runAgent()
}
export const rec: Recorded = freshRec();
function freshRec(): Recorded {
  return { builds: [], contractCalls: [], broadcasts: [], flash: [], recenter: [], journal: [], health: [], nonceChecks: [], samples: [], fetches: [], getWallet: 0, logs: [] };
}

// ---- fixtures -----------------------------------------------------------------------------
// Pair sbtc-stx: x = sBTC (8 dp), y = STX (6 dp, native). Mid 100,000 STX per sBTC.
// tradableInventory() holds back STX_FEE_RESERVE (50 STX) of y before any decision.
export interface World {
  midXinY: number;
  poolActive: boolean;
  xReserve: number;
  yReserve: number;
  feeBps: number;
  xBase: bigint; // free sBTC, base units
  yBase: bigint; // free STX (token balance), base units
  nativeStxMicro: bigint; // native STX balance (fee headroom)
  lpBase: bigint;
  externalMid: number | null; // CoinGecko reference mid (null = unavailable)
  nonce: { safe: boolean; reason?: string };
  swapYForXQuote: bigint; // dx quoted for a y→x swap (sBTC base)
  swapXForYQuote: bigint; // dy quoted for an x→y swap (STX base)
  wire: { txid?: string; error?: string }; // broadcastTransaction result
  txStatus: string; // what the tx-status poll reports
  recenterResult: Record<string, unknown>;
  flashResult: Record<string, unknown>;
  /** Called at the start of every cycle's market read with the 0-based cycle number. */
  onCycle?: (cycle: number, w: World) => void;
  /** Called with the result of every decide() (rebalance decision), before act() continues. */
  afterDecide?: (d: { action: string; amountBase: bigint }) => void;
}

export const MID = 100_000;
export const WALLET_KEY = "b4a1d5c0e4f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d601"; // throwaway, never funded
export const SWAP_CAP_Y = 50_000_000n; // defaultParams().maxSwapYBase (50 STX)

export function baseWorld(): World {
  return {
    midXinY: MID,
    poolActive: true,
    xReserve: 50,
    yReserve: 5_000_000,
    feeBps: 30,
    // In band: 0.001 sBTC (100 STX) vs 150 STX, of which 100 STX is tradable → 50/50.
    xBase: 100_000n,
    yBase: 150_000_000n,
    nativeStxMicro: 150_000_000n,
    lpBase: 0n,
    externalMid: MID,
    nonce: { safe: true },
    swapYForXQuote: 49_000n,
    swapXForYQuote: 1_000_000n,
    wire: { txid: "0xfeedbeef" },
    txStatus: "success",
    recenterResult: { action: "hold", reason: "in range", activeBin: 0, posLo: -3, posHi: 3, posX: 0, posY: 0, halfWidth: 3, executed: false },
    flashResult: { action: "skip", reason: "fake", requestedAmountStxBase: 0n, armedAmountStxBase: 0n, executed: false, skipped: true },
  };
}
/** Out of band toward y: 1050 STX (1000 tradable) vs 100 STX of sBTC → buy x, over the 50 STX cap. */
export function outOfBandWorld(): World {
  return { ...baseWorld(), yBase: 1_050_000_000n, nativeStxMicro: 1_050_000_000n };
}
/** Out of band but tiny: 4 STX of sBTC, no tradable STX → sell ~2 STX worth, below MIN_TRADE_VALUE_Y=5. */
export function belowMinWorld(): World {
  return { ...baseWorld(), xBase: 4_000n, yBase: 50_000_000n, nativeStxMicro: 50_000_000n };
}

export let world: World = baseWorld();

// ---- module mocks -------------------------------------------------------------------------
const realTx = await import("@stacks/transactions");
export const WALLET = { key: WALLET_KEY, address: realTx.getAddressFromPrivateKey(WALLET_KEY, "mainnet"), network: "mainnet" as const };

mock.module("@stacks/transactions", {
  namedExports: {
    ...realTx,
    fetchNonce: async () => 7n,
    makeContractCall: async (o: Parameters<typeof realTx.makeContractCall>[0]) => {
      const a = o as unknown as ContractCall;
      rec.contractCalls.push({ functionName: a.functionName, functionArgs: a.functionArgs, senderKey: a.senderKey, network: a.network });
      return realTx.makeContractCall(o); // signs with the throwaway key above; no network
    },
    broadcastTransaction: async (o: unknown) => {
      rec.broadcasts.push(o);
      return world.wire.txid ? { txid: world.wire.txid } : { error: world.wire.error ?? "rejected" };
    },
  },
});

mock.module("./rpc.js", {
  namedExports: {
    withRpc: async <T>(fn: (base: string) => Promise<T>) => fn("https://rpc.invalid"),
    hiroFetch: () => globalThis.fetch,
    hiroHeaders: () => ({}),
    endpoints: () => ["https://rpc.invalid"],
    redactEndpoint: (s: string) => s,
  },
});
const fakeFetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  rec.fetches.push(url);
  if (url.includes("/extended/v1/tx/")) return new Response(JSON.stringify({ tx_status: world.txStatus }), { status: 200 });
  throw new Error(`network disabled in agent-cli harness: ${url}`);
}) as typeof fetch;
globalThis.fetch = fakeFetch;

mock.module("./wallet.js", {
  namedExports: {
    loadDotenv: () => {},
    getNetwork: () => "mainnet",
    apiBase: () => "https://rpc.invalid",
    getWallet: async () => {
      rec.getWallet++;
      return { ...WALLET };
    },
    getStxBalance: async () => ({ stx: Number(world.nativeStxMicro) / 1e6, microStx: world.nativeStxMicro }),
    getTokenBalance: async (_a: string, _n: string, t: { symbol: string }) => (t.symbol === "sBTC" ? world.xBase : world.yBase),
    getLpBalance: async () => world.lpBase,
  },
});

let cycle = 0;
mock.module("../pool.js", {
  namedExports: {
    midFromReserves: () => world.midXinY,
    getPoolState: async () => {
      world.onCycle?.(cycle, world);
      cycle++;
      return {
        poolSymbol: "sBTC-STX", xToken: "x", yToken: "y", xDecimals: 8, yDecimals: 6,
        xReserve: world.xReserve, yReserve: world.yReserve, providerFeeBps: world.feeBps, protocolFeeBps: 0,
        feeBps: world.feeBps, midXinY: world.midXinY, poolActive: world.poolActive,
      };
    },
  },
});

const realQuotes = await import("./quotes.js");
mock.module("./quotes.js", {
  namedExports: {
    ...realQuotes,
    getSwapYForXQuote: async () => world.swapYForXQuote,
    getSwapXForYQuote: async () => world.swapXForYQuote,
    getAddLiquidityQuote: async (x: bigint) => ({ dlp: x, yAmount: x * 1000n }),
    getWithdrawQuote: async () => ({ xOut: 0n, yOut: 0n }),
    getPoolRaw: async () => { throw new Error("getPoolRaw not faked"); },
  },
});

// Real builders, recorded. Imported after the quotes / rpc / @stacks mocks, so they use them.
const realActions = await import("./actions.js");
const recordBuild = (fn: string, real: (amount: bigint, opts?: never) => Promise<unknown>) =>
  async (amount: bigint, opts: Record<string, unknown> = {}) => {
    rec.builds.push({ fn, amount, opts: { ...opts } });
    return real(amount, opts as never);
  };
mock.module("./actions.js", {
  namedExports: {
    ...realActions,
    buildSwapYForX: recordBuild("buildSwapYForX", realActions.buildSwapYForX),
    buildSwapXForY: recordBuild("buildSwapXForY", realActions.buildSwapXForY),
    buildAddLiquidity: recordBuild("buildAddLiquidity", realActions.buildAddLiquidity),
    buildWithdrawLiquidity: recordBuild("buildWithdrawLiquidity", realActions.buildWithdrawLiquidity),
  },
});

const realSafety = await import("./safety.js");
mock.module("./safety.js", {
  namedExports: {
    ...realSafety, // assessSafety + defaultSafetyParams stay real (and use the real kill.ts)
    getExternalMid: async () =>
      world.externalMid == null ? null : { xUsd: world.externalMid, yUsd: 1, midXinY: world.externalMid },
  },
});

const realAgent = await import("./agent.js");
mock.module("./agent.js", {
  namedExports: {
    ...realAgent,
    decide: (...a: Parameters<typeof realAgent.decide>) => {
      const d = realAgent.decide(...a);
      world.afterDecide?.(d);
      return d;
    },
  },
});

mock.module("./nonce-safety.js", {
  namedExports: {
    nonceSafetyFromResponse: () => world.nonce,
    checkNonceSafety: async (address: string) => {
      rec.nonceChecks.push(address);
      return world.nonce;
    },
  },
});

mock.module("./journal.js", {
  namedExports: {
    appendJournal: (e: Record<string, unknown>) => void rec.journal.push(structuredClone(e)),
    pingHealthcheck: async (s: "ok" | "fail" = "ok") => void rec.health.push(s),
  },
});

const realMetrics = await import("./metrics.js");
mock.module("./metrics.js", {
  namedExports: {
    ...realMetrics,
    recordSample: (_p: string, _w: string, _i: number, s: Record<string, unknown>) => void rec.samples.push(structuredClone(s)),
    loadHistory: () => [],
    adjustLpBasis: () => {},
    currentDrawdown: () => 0,
    // loadCapitalFlows / loadWalletMigrations stay REAL (CAPITAL_FLOWS_PATH / WALLET_MIGRATIONS_PATH
    // point into TMP): the drawdown gate adds recorded owner withdrawals back (C1 tests).
    setDlmmBasis: () => {},
  },
});

mock.module("./publish.js", {
  namedExports: { isPublishConfigured: () => false, publishMetrics: async () => true },
});

mock.module("./ai/tune.js", {
  namedExports: { tuneParams: async (_m: unknown, base: object) => ({ ...base, regime: "calm", rationale: "harness" }) },
});

mock.module("./crosspool.js", { namedExports: { parseCrossPools: () => [], scanCrossPools: async () => [] } });
const realGap = await import("./ststx-gap.js");
mock.module("./ststx-gap.js", { namedExports: { ...realGap, scanStstxGap: async () => [] } });
const realHedge = await import("./hedged-paper.js");
mock.module("./hedged-paper.js", { namedExports: { ...realHedge, btcFundingRate8h: async () => null } });

const realDlmmRead = await import("./dlmm-read.js");
mock.module("./dlmm-read.js", { namedExports: { ...realDlmmRead, readDlmmState: async () => null } });
const realDlmmPos = await import("./dlmm-position.js");
mock.module("./dlmm-position.js", {
  namedExports: { ...realDlmmPos, readUserPosition: async () => { throw new Error("readUserPosition not faked"); } },
});

mock.module("./dlmm-recenter-exec.js", {
  namedExports: {
    recenterOnce: async (_w: unknown, cfg: Record<string, unknown>, live: boolean) => {
      rec.recenter.push({ cfg: { ...cfg }, live });
      return { ...world.recenterResult };
    },
    resolveToken: async () => { throw new Error("resolveToken not faked"); },
    stxPriceUsd: async () => 1,
    ftBalance: async () => 0n,
    dlmmVol: () => ({ sigmaDaily: null, source: null }),
    pinnedHalfWidth: () => null,
  },
});

mock.module("../m2/flash-rebalance-exec.js", {
  namedExports: {
    flashRebalanceOnce: async (_w: unknown, cfg: unknown, live: boolean) => {
      rec.flash.push({ cfg, live });
      return { ...world.flashResult };
    },
  },
});

// ---- driving the agent --------------------------------------------------------------------
let instance = 0;
/** A fresh agent-cli module instance (same mocks), i.e. what a process restart would load. */
export async function loadAgent(): Promise<{ main: () => Promise<void> }> {
  return import(`./agent-cli.js?harness=${++instance}`);
}

export const STATE_FILES = [
  "DLMM_FAILSTREAK_STATE_PATH", "FLASH_FAILSTREAK_STATE_PATH", "EXPERIMENT_STATE_PATH",
  "XYK_TRADES_STATE_PATH", "DRAWDOWN_BASELINE_PATH", "CAPITAL_FLOWS_PATH", "WALLET_MIGRATIONS_PATH",
] as const;
export const statePath = (k: (typeof STATE_FILES)[number]): string => ENV_BASE[k];

/**
 * Reset fakes, records, env, KILL file and the cycle counter. Call in beforeEach. keepState
 * leaves the on-disk state files alone, i.e. what a process restart sees (pair it with a fresh
 * loadAgent() instance).
 */
export function resetHarness(w: World = baseWorld(), opts: { keepState?: boolean } = {}): void {
  mock.timers.reset();
  Object.assign(rec, freshRec());
  world = w;
  cycle = 0;
  resetEnv();
  rmSync(KILL_FILE, { force: true });
  if (!opts.keepState) for (const k of STATE_FILES) rmSync(ENV_BASE[k], { force: true });
}

export interface RunResult { error?: Error; settled: boolean }

/**
 * Run main() with the given CLI flags. Without --interval main() is one-shot and this waits for
 * it to return. With --interval it waits until `cycles` cycles have finished (each cycle ends in
 * exactly one healthcheck ping) and leaves the loop parked on its next sleep. setTimeout is
 * mocked so the 5 s tx-status polls and the interval sleeps run instantly.
 */
export async function runAgent(args: string[], opts: { cycles?: number; agent?: { main: () => Promise<void> } } = {}): Promise<RunResult> {
  const agent = opts.agent ?? (await loadAgent());
  const looping = args.includes("--interval");
  const cycles = opts.cycles ?? 1;
  const argv = process.argv;
  const con = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...a: unknown[]) => void rec.logs.push(a.map(String).join(" "));
  process.argv = [argv[0], argv[1], ...args]; // argv[1] stays the test file: flags() reads slice(2)
  console.log = console.warn = console.error = capture;
  mock.timers.enable({ apis: ["setTimeout"] });
  const healthAtStart = rec.health.length;
  const res: RunResult = { settled: false };
  try {
    agent.main().then(
      () => void (res.settled = true),
      (e: Error) => { res.settled = true; res.error = e; },
    );
    for (let i = 0; i < 20_000; i++) {
      await new Promise((r) => setImmediate(r));
      if (res.settled) break;
      if (looping && rec.health.length - healthAtStart >= cycles) {
        for (let j = 0; j < 20; j++) await new Promise((r) => setImmediate(r)); // let the cycle unwind to its sleep
        break;
      }
      mock.timers.runAll();
    }
    if (!res.settled && !looping) throw new Error("one-shot main() did not return");
    if (looping && rec.health.length - healthAtStart < cycles) throw new Error(`agent did not complete ${cycles} cycles`);
    return res;
  } finally {
    Object.assign(console, con);
    process.argv = argv;
  }
}

/** The per-tick journal records (one per cycle), as opposed to tune/xpool/dlmm/haven lines. */
export const tickEntries = () => rec.journal.filter((e) => e.type === undefined);
export const LIVE = ["--live", "--yes-mainnet"];
