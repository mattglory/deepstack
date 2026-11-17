// Integration tests for the live orchestrator (agent-cli.ts main()), through the harness in
// agent-cli.harness.ts. Every assertion is on recorded fakes: builder calls, the contract-call
// args those builders signed, wire-level broadcasts, journal lines and healthcheck pings.
// B4 / DSA-14.

import {
  rec, world, resetHarness, runAgent, loadAgent, touchKill, tickEntries,
  baseWorld, outOfBandWorld, belowMinWorld, WALLET, SWAP_CAP_Y, MID, LIVE, statePath,
} from "./agent-cli.harness.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Cl } from "@stacks/transactions";
import { minusSlippage } from "./quotes.js";
import { readFileSync, writeFileSync, rmSync } from "node:fs";

beforeEach(() => resetHarness());
// The fake global fetch throws on anything but the tx-status poll; also fail loudly here in
// case agent-cli ever swallows that error.
afterEach(() => {
  for (const u of rec.fetches) assert.match(u, /^https:\/\/rpc\.invalid\/extended\/v1\/tx\//, `unexpected network call: ${u}`);
});

const noBroadcast = () => {
  assert.equal(rec.builds.length, 0, "no builder called");
  assert.equal(rec.contractCalls.length, 0, "nothing signed");
  assert.equal(rec.broadcasts.length, 0, "nothing broadcast");
  assert.equal(rec.flash.length, 0, "no flash-rebalance");
};
const onlyTick = () => {
  const t = tickEntries();
  assert.equal(t.length, 1, "exactly one per-tick journal line");
  return t[0];
};

test("entrypoint guard: importing agent-cli does not start the agent", async () => {
  const agent = await loadAgent();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(typeof agent.main, "function");
  assert.equal(rec.getWallet, 0, "main() did not run on import");
  assert.equal(rec.journal.length, 0);
  assert.equal(rec.health.length, 0);
});

test("safety halt — divergence: zero broadcasts, halt journalled, healthcheck ok", async () => {
  resetHarness(outOfBandWorld()); // would trade if it were safe
  world.externalMid = MID * 1.1; // 9.09% > 5% band
  const r = await runAgent(LIVE);
  assert.equal(r.error, undefined);
  noBroadcast();
  const t = onlyTick();
  assert.equal(t.safe, false);
  assert.equal(t.mode, "live");
  assert.match((t.haltReasons as string[]).join(";"), /price divergence 9\.09%/);
  assert.equal(t.rebalance, undefined, "halted before the rebalance decision");
  assert.deepEqual(rec.health, ["ok"], "a halt is a completed cycle, not a failure ping");
});

test("safety halt — KILL file present: zero broadcasts, halt journalled", async () => {
  resetHarness(outOfBandWorld());
  touchKill();
  await runAgent(LIVE);
  noBroadcast();
  const t = onlyTick();
  assert.equal(t.safe, false);
  assert.deepEqual(t.haltReasons, ["manual kill-switch engaged"]);
  assert.deepEqual(rec.health, ["ok"]);
});

test("safety halt — session drawdown on cycle 2: zero broadcasts in either cycle", async () => {
  resetHarness(baseWorld()); // in band on cycle 1, so cycle 1 holds
  world.onCycle = (n, w) => {
    if (n === 1) { w.yBase = 100_000_000n; w.xBase = 50_000n; } // 250 → 150 STX portfolio: -40%
  };
  await runAgent([...LIVE, "--interval", "60"], { cycles: 2 });
  noBroadcast();
  const [t1, t2] = tickEntries();
  assert.equal(t1.safe, true);
  assert.equal(t2.safe, false);
  assert.match((t2.haltReasons as string[]).join(";"), /session drawdown 40\.00% > 15\.00% limit/);
  assert.equal(t2.rebalance, undefined);
  assert.deepEqual(rec.health, ["ok", "ok"]);
});

test("in band: hold, zero broadcasts", async () => {
  await runAgent(LIVE);
  noBroadcast();
  const t = onlyTick();
  assert.equal(t.safe, true);
  assert.equal((t.rebalance as { action: string }).action, "none");
  assert.match((t.rebalance as { reason: string }).reason, /within band/);
});

test("below the minimum trade size: hold, zero broadcasts", async () => {
  resetHarness(belowMinWorld());
  await runAgent(LIVE);
  noBroadcast();
  assert.deepEqual(onlyTick().rebalance, { action: "none", reason: "below minimum trade size" });
});

test("out of band, live gates open: exactly one capped swap with the expected min-out", async () => {
  resetHarness(outOfBandWorld());
  const r = await runAgent(LIVE);
  assert.equal(r.error, undefined);

  // What agent-cli asked the builder for: the capped amount (uncapped need is ~450 STX).
  assert.equal(rec.builds.length, 1);
  const b = rec.builds[0];
  assert.equal(b.fn, "buildSwapYForX");
  assert.equal(b.amount, SWAP_CAP_Y);
  assert.equal(b.opts.slippageBps, 100);
  assert.equal(b.opts.broadcast, true);
  assert.equal(b.opts.network, "mainnet");
  assert.equal(b.opts.feeMicroStx, 50_000n);
  assert.equal(b.opts.senderKey, WALLET.key);

  // What the builder signed from it: amount in, min-out = quote minus 1% slippage.
  assert.equal(rec.contractCalls.length, 1);
  const c = rec.contractCalls[0];
  assert.equal(c.functionName, "swap-y-for-x");
  assert.deepEqual(c.functionArgs[3], Cl.uint(SWAP_CAP_Y));
  assert.deepEqual(c.functionArgs[4], Cl.uint(minusSlippage(world.swapYForXQuote, 100)));
  assert.deepEqual(c.functionArgs[4], Cl.uint(48_510n));

  assert.equal(rec.broadcasts.length, 1);
  assert.deepEqual(rec.fetches, ["https://rpc.invalid/extended/v1/tx/0xfeedbeef"], "confirmation polled");
  assert.deepEqual(rec.nonceChecks, [WALLET.address]);
  const t = onlyTick();
  assert.equal(t.action, "swap-y-for-x");
  assert.equal(t.txid, "0xfeedbeef");
  assert.equal(t.status, "success");
  assert.deepEqual(rec.health, ["ok"]);
});

test("not live: decides the swap but broadcasts nothing (no --live, and --live without --yes-mainnet)", async () => {
  for (const args of [[], ["--live"]]) {
    resetHarness(outOfBandWorld());
    await runAgent(args);
    noBroadcast();
    assert.deepEqual(rec.nonceChecks, [], "nonce check only runs when a broadcast is possible");
    const t = onlyTick();
    assert.equal(t.mode, "observe");
    assert.equal((t.rebalance as { action: string }).action, "swap-y-for-x");
    assert.ok(rec.logs.includes("  observe mode — not executing"), `args ${args}`);
  }
});

test("nonce safety failure: refused, zero broadcasts", async () => {
  resetHarness(outOfBandWorld());
  world.nonce = { safe: false, reason: "pending tx at nonce 7" };
  await runAgent(LIVE);
  noBroadcast();
  const t = onlyTick();
  assert.equal(t.safe, true);
  assert.equal(t.refused, "pending tx at nonce 7");
});

test("C8: KILL created after the decision is caught by the re-check right before broadcast", async () => {
  resetHarness(outOfBandWorld());
  let decided = 0;
  world.afterDecide = (d) => {
    if (d.action !== "none") { decided++; touchKill(); }
  };
  await runAgent(LIVE);
  assert.equal(decided, 1, "the swap was decided");
  noBroadcast();
  const t = onlyTick();
  assert.equal(t.safe, true, "the cycle's safety gate passed: KILL did not exist yet");
  assert.equal(t.refused, "kill switch engaged");
});

test("trade count and --max-trades: a lifetime cap, persisted across restarts (C1)", async () => {
  resetHarness(outOfBandWorld()); // fakes never move the inventory, so every cycle wants the swap
  const args = [...LIVE, "--interval", "60", "--max-trades", "2"];
  const agent = await loadAgent();
  await runAgent(args, { cycles: 3, agent });
  assert.equal(rec.broadcasts.length, 2, "--max-trades 2 caps successful trades at 2");
  assert.deepEqual(tickEntries().map((t) => t.mode), ["live", "live", "observe"]);
  assert.ok(rec.logs.includes("\n(reached --max-trades 2; observe-only now)"));

  // C1 / DSA-07: a restarted process (fresh module instance, state files kept) remembers the
  // 2 trades: the same --max-trades 2 leaves no budget ...
  resetHarness(outOfBandWorld(), { keepState: true });
  await runAgent([...LIVE, "--max-trades", "2"]);
  assert.equal(rec.broadcasts.length, 0, "restart did not re-arm the lifetime budget");
  assert.equal(onlyTick().mode, "observe");
  assert.deepEqual(JSON.parse(readFileSync(statePath("XYK_TRADES_STATE_PATH"), "utf8")), { trades: 2 });
  // ... and a raised ceiling allows exactly the difference (60 - N in production).
  resetHarness(outOfBandWorld(), { keepState: true });
  await runAgent([...LIVE, "--max-trades", "3"]);
  assert.equal(rec.broadcasts.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(statePath("XYK_TRADES_STATE_PATH"), "utf8")), { trades: 3 });

  // A failed broadcast does not count as a trade.
  resetHarness(outOfBandWorld());
  world.wire = { error: "ConflictingNonceInMempool" };
  await runAgent([...LIVE, "--interval", "60", "--max-trades", "1"], { cycles: 2 });
  assert.equal(rec.broadcasts.length, 2, "both cycles still live: nothing succeeded");
  assert.deepEqual(tickEntries().map((t) => t.mode), ["live", "live"]);
});

test("C1: an unreadable trade-count file fails closed: observe-only, file left for a human", async () => {
  resetHarness(outOfBandWorld());
  writeFileSync(statePath("XYK_TRADES_STATE_PATH"), "{ not json");
  await runAgent([...LIVE, "--max-trades", "60"]);
  noBroadcast();
  assert.equal(onlyTick().mode, "observe");
  assert.equal(readFileSync(statePath("XYK_TRADES_STATE_PATH"), "utf8"), "{ not json");
});

// Portfolio in baseWorld: 0.001 sBTC (100 STX) + 150 STX = 250 STX. yBase 100 STX → 200 (-20%).
const down20 = () => ({ ...baseWorld(), yBase: 100_000_000n, nativeStxMicro: 100_000_000n });
const baselineFile = () => JSON.parse(readFileSync(statePath("DRAWDOWN_BASELINE_PATH"), "utf8"));

test("C1: the drawdown baseline survives a restart: a loss before the restart still halts", async () => {
  await runAgent(LIVE); // first process: baseline 250
  assert.equal(onlyTick().safe, true);

  resetHarness(down20(), { keepState: true }); // restart after a 20% loss
  await runAgent(LIVE);
  noBroadcast();
  const t = onlyTick();
  assert.equal(t.safe, false, "restart did not re-baseline at the post-loss value");
  assert.match((t.haltReasons as string[]).join(";"), /session drawdown 20\.00% > 15\.00% limit/);
  const b = baselineFile();
  assert.equal(b.portfolioY, 250, "baseline unchanged");
  assert.equal(b.pair, "sbtc-stx");
  assert.equal(b.wallet, WALLET.address);
});

test("C1: an owner withdrawal recorded after the baseline is added back: no false halt, no reset", async () => {
  await runAgent(LIVE); // baseline 250, taken now
  writeFileSync(statePath("CAPITAL_FLOWS_PATH"), JSON.stringify([
    { t: new Date(Date.now() + 60_000).toISOString(), txid: "0xw1", stx: -50, note: "owner withdrawal" },
  ]));
  resetHarness(down20(), { keepState: true }); // 200 now + 50 withdrawn = 250: no drawdown
  await runAgent(LIVE);
  assert.equal(onlyTick().safe, true);
  assert.equal(baselineFile().portfolioY, 250, "the withdrawal did not reset the baseline");
});

test("C1: a recorded key rotation carries the baseline to the new wallet; an unrecorded wallet change halts", async () => {
  const OLD = "SP000000000000000000002Q6VF78";
  const stored = { portfolioY: 250, t: "2026-11-01T00:00:00.000Z", pair: "sbtc-stx", wallet: OLD };
  writeFileSync(statePath("DRAWDOWN_BASELINE_PATH"), JSON.stringify(stored));
  writeFileSync(statePath("WALLET_MIGRATIONS_PATH"), JSON.stringify([
    { t: "2026-11-02T00:00:00.000Z", from: OLD, to: WALLET.address, txids: [], note: "key rotation" },
  ]));
  resetHarness(down20(), { keepState: true });
  await runAgent(LIVE);
  let t = onlyTick();
  assert.equal(t.safe, false, "the migrated wallet is measured against the carried baseline");
  assert.match((t.haltReasons as string[]).join(";"), /session drawdown 20\.00%/);
  assert.equal(baselineFile().portfolioY, 250);
  assert.equal(baselineFile().wallet, WALLET.address, "re-keyed to the new wallet");

  // Same file, no recorded rotation: a different agent's baseline — halt, never silently reset.
  writeFileSync(statePath("DRAWDOWN_BASELINE_PATH"), JSON.stringify(stored));
  rmSync(statePath("WALLET_MIGRATIONS_PATH"));
  resetHarness(outOfBandWorld(), { keepState: true });
  await runAgent(LIVE);
  noBroadcast();
  t = onlyTick();
  assert.equal(t.safe, false);
  assert.match((t.haltReasons as string[]).join(";"), /drawdown baseline unusable: baseline is for wallet SP000000000000000000002Q6VF78/);
  assert.deepEqual(baselineFile(), stored, "file left untouched for a human");
});

test("C1: an unreadable drawdown baseline fails closed: halt (XYK and DLMM), file left for a human", async () => {
  resetHarness(outOfBandWorld());
  Object.assign(process.env, { DLMM_OBSERVE_PAIR: "sbtc-usdcx", DLMM_LIVE: "1" });
  writeFileSync(statePath("DRAWDOWN_BASELINE_PATH"), "{ not json");
  await runAgent(LIVE);
  noBroadcast();
  const t = onlyTick();
  assert.equal(t.safe, false);
  assert.match((t.haltReasons as string[]).join(";"), /drawdown baseline unusable/);
  assert.equal(rec.recenter[0].live, false, "DLMM gated by the same halt");
  assert.equal(readFileSync(statePath("DRAWDOWN_BASELINE_PATH"), "utf8"), "{ not json");
});

test("DLMM step: invoked per DLMM_OBSERVE_PAIR, live flag per DLMM_LIVE / --live / safety", async () => {
  const PAIR = "sbtc-usdcx";
  const run = async (env: Record<string, string>, args: string[], w = baseWorld()) => {
    resetHarness(w);
    Object.assign(process.env, env);
    await runAgent(args);
    return rec.recenter;
  };

  assert.equal((await run({}, LIVE)).length, 0, "no DLMM_OBSERVE_PAIR → no DLMM step");

  let r = await run({ DLMM_OBSERVE_PAIR: PAIR }, LIVE);
  assert.equal(r.length, 1);
  assert.equal(r[0].live, false, "DLMM_LIVE unset → observe");
  assert.equal(r[0].cfg.pair, PAIR);
  assert.equal(rec.journal.find((e) => e.type === "dlmm-observe")?.pair, PAIR);

  r = await run({ DLMM_OBSERVE_PAIR: PAIR, DLMM_LIVE: "1" }, []);
  assert.equal(r[0].live, false, "DLMM_LIVE=1 without --live → observe");

  r = await run({ DLMM_OBSERVE_PAIR: PAIR, DLMM_LIVE: "1" }, ["--live"]);
  assert.equal(r[0].live, false, "DLMM_LIVE=1 with --live but no --yes-mainnet → observe");

  const diverged = { ...baseWorld(), externalMid: MID * 1.1 };
  r = await run({ DLMM_OBSERVE_PAIR: PAIR, DLMM_LIVE: "1" }, LIVE, diverged);
  assert.equal(r[0].live, false, "unsafe cycle → observe");

  r = await run({ DLMM_OBSERVE_PAIR: PAIR, DLMM_LIVE: "1" }, LIVE);
  assert.equal(r[0].live, true, "all gate terms open → live");
  assert.ok(rec.journal.some((e) => e.type === "dlmm-recenter"));
  assert.deepEqual(rec.health, ["ok"]);
  noBroadcast(); // the XYK leg was in band; DLMM broadcasts are recenterOnce's (faked) business
});

test("DLMM live attempt that fails: healthcheck pings fail, fail streak persisted", async () => {
  resetHarness(baseWorld());
  Object.assign(process.env, { DLMM_OBSERVE_PAIR: "sbtc-usdcx", DLMM_LIVE: "1" });
  world.recenterResult = { ...world.recenterResult, action: "recenter", executed: false };
  await runAgent(LIVE);
  assert.equal(rec.recenter[0].live, true);
  assert.deepEqual(rec.health, ["fail"]);
  assert.equal(rec.journal.find((e) => e.type === "dlmm-recenter")?.dlmmFailStreak, 1);
  assert.deepEqual(JSON.parse(readFileSync(process.env.DLMM_FAILSTREAK_STATE_PATH!, "utf8")), { dlmmFailStreak: 1, dlmmRecenters: 0 });
});

test("C2 cycle watchdog: an over-long cycle pings fail + is journalled; no overlapping cycle until it finishes", async () => {
  resetHarness(baseWorld());
  process.env.CYCLE_TIMEOUT_MS = "120000"; // 2 min (default 45 min); interval 60 s
  let release!: () => void;
  world.hang = new Promise<void>((r) => (release = r));
  let poolReads = 0;
  world.onCycle = () => void poolReads++;
  const agent = await loadAgent();
  const args = [...LIVE, "--interval", "60"];

  // Cycle 1 hangs in its market read. At 2 min the watchdog reports it; the next interval
  // finds it still running and skips instead of starting a second cycle beside it.
  await runAgent(args, { cycles: 2, agent });
  assert.deepEqual(rec.health, ["fail", "fail"]);
  assert.equal(rec.journal.filter((e) => e.type === "cycle-timeout").length, 1);
  assert.equal(rec.journal.filter((e) => e.type === "cycle-skipped").length, 1);
  assert.equal(poolReads, 1, "no second cycle started while the first was in flight");
  assert.equal(tickEntries().length, 0);

  // The stuck cycle is not abandoned: once it finishes, it completes normally (its own ping) ...
  world.hang = undefined;
  release();
  await runAgent(args, { cycles: 1, agent, resume: true });
  assert.equal(rec.health[2], "ok");
  assert.equal(tickEntries().length, 1);
  assert.ok(rec.journal.some((e) => e.type === "cycle-late-finish"));
  // ... and the following interval runs a fresh cycle again.
  await runAgent(args, { cycles: 1, agent, resume: true });
  assert.equal(poolReads, 2);
  assert.deepEqual(rec.health.slice(3), ["ok"]);
  assert.equal(tickEntries().length, 2);
});

test("risk-state files that need a human (unreadable / unrelated wallet / corrupt breakers) halt AND alert: ping fail, journal risk-state-unreadable", async () => {
  const OTHER = { portfolioY: 250, t: "2026-11-01T00:00:00.000Z", pair: "sbtc-stx", wallet: "SP000000000000000000002Q6VF78" };
  const cases: [string, () => void][] = [
    ["xyk trades unreadable", () => writeFileSync(statePath("XYK_TRADES_STATE_PATH"), "{ not json")],
    ["baseline unreadable", () => writeFileSync(statePath("DRAWDOWN_BASELINE_PATH"), "{ not json")],
    ["baseline for an unrelated wallet", () => writeFileSync(statePath("DRAWDOWN_BASELINE_PATH"), JSON.stringify(OTHER))],
    ["dlmm failstreak corrupt", () => writeFileSync(statePath("DLMM_FAILSTREAK_STATE_PATH"), "{ not json")],
    ["flash failstreak corrupt", () => writeFileSync(statePath("FLASH_FAILSTREAK_STATE_PATH"), "{ not json")],
  ];
  // In band, so no case would broadcast anyway (the halting itself is covered by the C1 tests;
  // a corrupt DLMM/flash breaker file only shuts its own path).
  for (const [name, breakIt] of cases) {
    resetHarness(baseWorld());
    breakIt();
    await runAgent(LIVE);
    assert.deepEqual(rec.health, ["fail"], name);
    const t = onlyTick();
    assert.equal(t.alert, "risk-state-unreadable", name);
    assert.ok((t.riskStateProblems as string[]).length >= 1, name);
  }
  // Ordinary safety halts are unchanged: still "ok", no risk-state alert.
  resetHarness({ ...outOfBandWorld(), externalMid: MID * 1.1 });
  await runAgent(LIVE);
  assert.deepEqual(rec.health, ["ok"]);
  assert.equal(onlyTick().alert, undefined);
});
