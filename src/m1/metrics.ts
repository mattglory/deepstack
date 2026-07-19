// Pilot metrics logger — the evidence trail for grant M1/M2.
//
// Each agent cycle appends a sample (heartbeat + mid + inventory) to
// dashboard/metrics.json. Because the file lives inside dashboard/, deploying the
// dashboard publishes it same-origin (/metrics.json) — no backend, no CORS, no keys.
// The dashboard derives from it: uptime (actual vs expected heartbeats), mid/quote
// history (sparkline), and IL-adjusted return (current portfolio vs HODL-the-baseline).
// On-chain transactions remain the independently verifiable source of truth; this file
// is supporting evidence for cadence/uptime and price context.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const METRICS_PATH = process.env.METRICS_PATH ?? "dashboard/metrics.json";
// 2000 holds ~41 days at the pilot's 30-min cadence — the whole run fits with margin.
// Raise via env only alongside a finer --interval; the two must be decided together
// (finer sampling improves the realised-vol estimate that sizes the band and LVR).
const MAX_SAMPLES = Number(process.env.MAX_SAMPLES ?? 2000);

export interface MetricsSample {
  t: string; // ISO timestamp
  mid: number; // on-chain pool mid (y per x)
  ext: number | null; // external reference mid
  xBase: string; // free x inventory (base units, stringified bigint)
  yBase: string; // free y inventory
  lpValueY: number; // LP position value in y
  portfolioY: number; // total portfolio value in y
  safe: boolean; // safety gate outcome this cycle
  // Pool reserves at sample time (human units, optional — added 2026-07-19). k = x·y
  // grows only from fees on an XYK pool, so this series measures the pool's realised
  // fee yield and IL — the inputs for regime-matched allocation (post-pilot design).
  poolX?: number;
  poolY?: number;
}

export interface MetricsFile {
  pair: string;
  wallet: string;
  startedAt: string;
  intervalSec: number; // expected cadence — lets the dashboard compute uptime honestly
  baseline: { t: string; xBase: string; yBase: string; mid: number; portfolioY: number };
  // Cost basis of the LP position, as the deposited LEG QUANTITIES (x in human units,
  // y in human units) plus when tracking started. The honest income figure is
  //   feesNetIL = current LP value − (xQty·mid + yQty)
  // i.e. LP vs simply HOLDING the deposited legs — the definition of fees net of
  // impermanent loss. A scalar STX basis would smuggle the x-leg's price moves into
  // "income". Maintained on every add/withdraw; auto-initialised for positions that
  // predate tracking (fresh XYK deposits are always 50/50 by value).
  lpBasis?: { xQty: number; yQty: number; t: string };
  lpBasisY?: number; // legacy scalar — migrated to lpBasis on the next sample
  // Official pilot window. When set, the dashboard scopes uptime, IL-adjusted return,
  // and the price chart to the window, and the P&L report defaults its --since to it.
  // Set once by `m2:pilot-start` on the pilot box; funding must be complete BEFORE this.
  pilotStartedAt?: string;
  pilotBaseline?: { t: string; xBase: string; yBase: string; mid: number; portfolioY: number };
  samples: MetricsSample[];
  updated: string;
}

function load(): MetricsFile | null {
  try {
    if (!existsSync(METRICS_PATH)) return null;
    return JSON.parse(readFileSync(METRICS_PATH, "utf8")) as MetricsFile;
  } catch {
    return null; // corrupt file -> start fresh rather than crash the agent
  }
}

/**
 * The recorded mid/LP history, for deriving realised volatility and LVR. Empty when no
 * file exists yet — callers must treat "not enough history" as a normal state, not an
 * error, or the agent can't run on a fresh box.
 */
export function loadHistory(): MetricsSample[] {
  return load()?.samples ?? [];
}

export function recordSample(
  pair: string,
  wallet: string,
  intervalSec: number,
  s: MetricsSample,
): void {
  try {
    let m = load();
    // Start a fresh file when absent or the pair/wallet changed (new pilot context).
    if (!m || m.pair !== pair || m.wallet !== wallet) {
      m = {
        pair,
        wallet,
        startedAt: s.t,
        intervalSec,
        baseline: { t: s.t, xBase: s.xBase, yBase: s.yBase, mid: s.mid, portfolioY: s.portfolioY },
        samples: [],
        updated: s.t,
      };
    }
    m.intervalSec = intervalSec; // keep current cadence
    if (!m.lpBasis && s.mid > 0) {
      // Initialise (or migrate the legacy scalar): split 50/50 by value at current mid.
      const v = m.lpBasisY ?? (s.lpValueY > 0 ? s.lpValueY : 0);
      if (v > 0) m.lpBasis = { xQty: v / 2 / s.mid, yQty: v / 2, t: s.t };
      delete m.lpBasisY;
    }
    m.samples.push(s);
    if (m.samples.length > MAX_SAMPLES) m.samples = m.samples.slice(-MAX_SAMPLES);
    m.updated = s.t;
    mkdirSync(dirname(METRICS_PATH), { recursive: true });
    writeFileSync(METRICS_PATH, JSON.stringify(m));
  } catch (err) {
    // Metrics are evidence, not safety-critical — never take the agent down over them.
    console.warn(`(metrics write skipped: ${(err as Error).message})`);
  }
}

/**
 * Anchor the official pilot window at the latest recorded sample. Idempotent by refusal:
 * a second call throws rather than silently moving the window (evidence windows are not
 * renegotiable mid-run — that is the whole point of having one).
 */
export function markPilotStart(): { startedAt: string; portfolioY: number } {
  const m = load();
  if (!m || m.samples.length === 0) throw new Error("no telemetry yet — run a cycle first");
  if (m.pilotStartedAt) throw new Error(`pilot already started at ${m.pilotStartedAt}`);
  const s = m.samples[m.samples.length - 1];
  m.pilotStartedAt = s.t;
  m.pilotBaseline = { t: s.t, xBase: s.xBase, yBase: s.yBase, mid: s.mid, portfolioY: s.portfolioY };
  writeFileSync(METRICS_PATH, JSON.stringify(m));
  return { startedAt: s.t, portfolioY: s.portfolioY };
}

/**
 * Adjust the LP cost basis after an executed LP action.
 *   add:      both deposited leg quantities are appended (t is kept from first deposit)
 *   withdraw: both legs scale down by the withdrawn fraction (proportional burn)
 * Never throws — same policy as recordSample.
 */
export function adjustLpBasis(
  evt:
    | { kind: "add"; xQty: number; yQty: number; t: string }
    | { kind: "withdraw"; fraction: number },
): void {
  try {
    const m = load();
    if (!m) return;
    const b = m.lpBasis ?? { xQty: 0, yQty: 0, t: evt.kind === "add" ? evt.t : new Date().toISOString() };
    // Keep the recorded pair CONSISTENT: the cycle's sample was taken before the action,
    // the basis after it — comparing post-action basis against a pre-action LP value shows
    // every in-flight add as a fake loss (≈ the add's size) until the next cycle. So the
    // same event that moves the basis also moves the last sample's LP value estimate; the
    // next cycle's real reading replaces the estimate.
    const last = m.samples[m.samples.length - 1];
    if (evt.kind === "add") {
      m.lpBasis = { xQty: b.xQty + Math.max(0, evt.xQty), yQty: b.yQty + Math.max(0, evt.yQty), t: b.t };
      if (last) last.lpValueY += 2 * Math.max(0, evt.yQty); // equal-value legs by construction
    } else {
      const keep = 1 - Math.min(1, Math.max(0, evt.fraction));
      m.lpBasis = { xQty: b.xQty * keep, yQty: b.yQty * keep, t: b.t };
      if (last) last.lpValueY *= keep;
    }
    writeFileSync(METRICS_PATH, JSON.stringify(m));
  } catch (err) {
    console.warn(`(lp basis update skipped: ${(err as Error).message})`);
  }
}
