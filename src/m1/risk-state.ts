// Restart-surviving XYK risk state (C1 / DSA-07): the lifetime XYK trade count behind
// --max-trades, and the drawdown baseline behind the 15% session-drawdown halt. Both used to be
// locals in agent-cli.ts's main(), so every restart (systemd Restart=always) re-armed the full
// --max-trades budget and re-baselined the drawdown halt at whatever the portfolio was worth
// then, i.e. after a loss. Same discipline as dlmm-failstreak-state.ts (C7):
//
//   - missing file = fresh install: trade count 0 / no baseline yet (the first successful
//     market read sets it);
//   - file present but unreadable, unparseable or invalid = FAIL CLOSED, never a silent reset:
//     the trade count reads as exhausted (XYK observe-only) and the baseline reads as unusable
//     (agent-cli adds a safety-halt reason, so XYK, flash and DLMM all stop). The bad file is
//     left in place for a human to inspect;
//   - writes are atomic (temp file + rename).
//
// Operator resets: delete the file and restart. journal/xyk-trades.json resets the lifetime
// trade budget; journal/drawdown-baseline.json re-baselines the drawdown halt at the next read.
//
// Config: XYK_TRADES_STATE_PATH (default journal/xyk-trades.json),
//         DRAWDOWN_BASELINE_PATH (default journal/drawdown-baseline.json).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function xykTradesStatePath(): string {
  return process.env.XYK_TRADES_STATE_PATH ?? "journal/xyk-trades.json";
}
export function drawdownBaselinePath(): string {
  return process.env.DRAWDOWN_BASELINE_PATH ?? "journal/drawdown-baseline.json";
}

/** Read as "budget exhausted": >= any --max-trades, so xykLiveGate's `trades < maxTrades` is false. */
export const EXHAUSTED_TRADES = Number.MAX_SAFE_INTEGER;

function atomicWrite(path: string, value: unknown, what: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch (e) {
    // Must not take the agent down, but must be visible: the in-memory value still holds.
    console.error(`⛔ ${what} NOT saved (${path}): ${(e as Error).message}`);
  }
}

/** undefined = the file does not exist; throws for any other read error. */
function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export function loadXykTrades(path: string = xykTradesStatePath()): { trades: number; corrupt?: true } {
  try {
    const raw = readIfExists(path);
    if (raw === undefined) return { trades: 0 };
    const n = JSON.parse(raw)?.trades;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) return { trades: n };
    throw new Error("missing or invalid `trades` field");
  } catch (e) {
    console.error(`⛔ XYK TRADE COUNT UNREADABLE (${path}: ${(e as Error).message}) — treating the --max-trades budget as EXHAUSTED; XYK trading stays observe-only until a human inspects and deletes the file`);
    return { trades: EXHAUSTED_TRADES, corrupt: true };
  }
}

export function saveXykTrades(trades: number, path: string = xykTradesStatePath()): void {
  atomicWrite(path, { trades }, "XYK trade count");
}

export interface DrawdownBaseline {
  portfolioY: number; // portfolio value (pair's y units) the 15% halt is measured against
  t: string; // when it was taken; owner withdrawals recorded after this are added back
  pair: string; // the pair whose y units portfolioY is in
  wallet: string; // the agent address it was taken for (followed through recorded key rotations)
}

export type BaselineLoad =
  | { kind: "none" }
  | { kind: "ok"; baseline: DrawdownBaseline }
  | { kind: "corrupt"; why: string };

export function loadDrawdownBaseline(path: string = drawdownBaselinePath()): BaselineLoad {
  try {
    const raw = readIfExists(path);
    if (raw === undefined) return { kind: "none" };
    const j = JSON.parse(raw);
    const ok =
      typeof j?.portfolioY === "number" && Number.isFinite(j.portfolioY) && j.portfolioY > 0 &&
      typeof j.t === "string" && Number.isFinite(Date.parse(j.t)) &&
      typeof j.pair === "string" && j.pair !== "" &&
      typeof j.wallet === "string" && j.wallet !== "";
    if (!ok) throw new Error("missing or invalid fields");
    return { kind: "ok", baseline: { portfolioY: j.portfolioY, t: j.t, pair: j.pair, wallet: j.wallet } };
  } catch (e) {
    return { kind: "corrupt", why: `${path}: ${(e as Error).message}` };
  }
}

export function saveDrawdownBaseline(b: DrawdownBaseline, path: string = drawdownBaselinePath()): void {
  atomicWrite(path, b, "drawdown baseline");
}

/**
 * Whether a stored baseline applies to this agent: same pair, and the same wallet or one reached
 * from it through recorded key rotations (metrics.ts walletMigrations; rotate-key-cli moves the
 * same capital, so the baseline carries over). Returns why not, or null when it applies.
 */
export function baselineMismatch(
  b: DrawdownBaseline,
  pair: string,
  wallet: string,
  migrations: { from: string; to: string }[],
): string | null {
  if (b.pair !== pair) return `baseline is for pair ${b.pair}, agent runs ${pair}`;
  let at = b.wallet;
  for (let hops = 0; at !== wallet && hops <= migrations.length; hops++) {
    const next = migrations.find((m) => m.from === at);
    if (!next) break;
    at = next.to;
  }
  return at === wallet ? null : `baseline is for wallet ${b.wallet}, with no recorded key rotation to ${wallet}`;
}
