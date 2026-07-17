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

const METRICS_PATH = process.env.METRICS_PATH ?? "dashboard/metrics.json";
const MAX_SAMPLES = 2000; // ~1.4 days @60s, ~41 days @30min — enough for the pilot at a sane cadence

export interface MetricsSample {
  t: string; // ISO timestamp
  mid: number; // on-chain pool mid (y per x)
  ext: number | null; // external reference mid
  xBase: string; // free x inventory (base units, stringified bigint)
  yBase: string; // free y inventory
  lpValueY: number; // LP position value in y
  portfolioY: number; // total portfolio value in y
  safe: boolean; // safety gate outcome this cycle
}

export interface MetricsFile {
  pair: string;
  wallet: string;
  startedAt: string;
  intervalSec: number; // expected cadence — lets the dashboard compute uptime honestly
  baseline: { t: string; xBase: string; yBase: string; mid: number; portfolioY: number };
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
