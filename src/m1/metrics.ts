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
import { execSync } from "node:child_process";

export const METRICS_PATH = process.env.METRICS_PATH ?? "dashboard/metrics.json";

// Which commit produced these numbers — otherwise the only way to know is to ask the
// operator (found via external review, 2026-09: a status message cited a stale commit
// hash with nothing published to catch the drift). Computed once per process and cached.
//
// The pilot VPS runs from a plain rsync copy (deploy/install.sh excludes .git from the
// sync on purpose, so an update never has to re-clone), so `git rev-parse` from the
// process's own cwd fails there — install.sh stamps the source commit into
// .deployed-commit instead. Falls back to git for local/dev runs (e.g. straight from
// the cloned repo), where that file won't exist.
let deployedCommitCache: string | undefined | null = null;
function deployedCommit(): string | undefined {
  if (deployedCommitCache === null) {
    try {
      deployedCommitCache = readFileSync(".deployed-commit", "utf8").trim() || undefined;
    } catch {
      try {
        deployedCommitCache = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim();
      } catch {
        deployedCommitCache = undefined;
      }
    }
  }
  return deployedCommitCache;
}
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
  dlmmValueY?: number; // DLMM position value in y (optional — only present once DLMM is active)
  freeUsdcxValueY?: number; // free (non-DLMM-locked) USDCx value in y this tick
  stxUsd?: number; // USD per STX used to value the DLMM position's non-STX leg this tick
  dlmmActiveBin?: number; // DLMM pool's active bin this tick (absent when the read failed) — the vol source for range width
  dlmmBinStep?: number; // that pool's bin step in bps, so a bin series is never mixed across pools
  portfolioY: number; // total portfolio value in y
  safe: boolean; // safety gate outcome this cycle
  // Pool reserves at sample time (human units, optional — added 2026-07-19). k = x·y
  // grows only from fees on an XYK pool, so this series measures the pool's realised
  // fee yield and IL — the inputs for regime-matched allocation (post-pilot design).
  poolX?: number;
  poolY?: number;
}

// An owner deposit into or withdrawal from the agent wallet: capital that changed hands with
// the outside world, not a trading result. `stx` is signed, in STX: negative = withdrawn.
// Added 2026-10-22 after two owner withdrawals (65 STX on 10-14, 700 STX on 10-22) showed up as
// losses on the dashboard's HODL comparison and as drawdown in the agent's own risk checks.
export interface CapitalFlow { t: string; txid: string; stx: number; note?: string }

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
  // Same idea as lpBasis, for the DLMM position: deposited leg quantities (x in human
  // units, y/USDCx in human units) plus when tracking started. Recenters (withdraw +
  // immediate re-add of the SAME wallet-owned capital) do not move this — only a genuine
  // net capital add/withdraw to the DLMM position should. Auto-initialised 50/50 by value
  // on the first sample that has a positive dlmmValueY and no existing basis; a more
  // accurate basis (the position's real x/y split, not a 50/50 guess) can be seeded
  // manually when the true composition is known, e.g. via a historical on-chain read.
  dlmmBasis?: { xQty: number; yQty: number; t: string };
  // Official pilot window. When set, the dashboard scopes uptime, IL-adjusted return,
  // and the price chart to the window, and the P&L report defaults its --since to it.
  // Set once by `m2:pilot-start` on the pilot box; funding must be complete BEFORE this.
  pilotStartedAt?: string;
  // usdcxQty: free (non-DLMM-locked) USDCx held at anchor, in human units. Added after
  // the fact (2026-09-13) once IL-adjusted return was found comparing the FULL portfolio
  // (free + LP + DLMM + free-USDCx, since the readMarket() fixes) against a baseline that
  // only ever captured free xBase/yBase — an apples-to-a-third-of-an-orange comparison.
  // Without this field, hodlNow undercounts the true anchor-time baseline by whatever
  // free USDCx existed then.
  //
  // lpBasis/dlmmBasis (added 2026-09-22): a SNAPSHOT of the top-level lpBasis/dlmmBasis at
  // the moment the pilot started — deliberately separate from those top-level fields, which
  // are meant to evolve (adjustLpBasis on real add/withdraw events; dlmmBasis resets when a
  // position goes empty and is later reopened, see recordSample). "IL-adjusted return"/the
  // Performance chart need a genuinely FIXED, top-up-free baseline for the life of the pilot
  // (see dashboard's hodlNow doc comment) — pointing them at the mutable top-level fields
  // instead is exactly the bug found 2026-09-22: a DLMM position withdrawn and reopened hours
  // later (a real capital event, correctly resetting the top-level dlmmBasis for the DLMM
  // P&L card) silently moved the PILOT-WIDE comparison's basis too, retroactively changing
  // what "hold your original pilot-start basket" meant for the whole chart.
  pilotBaseline?: {
    t: string; xBase: string; yBase: string; mid: number; portfolioY: number; usdcxQty?: number;
    lpBasis?: { xQty: number; yQty: number };
    dlmmBasis?: { xQty: number; yQty: number };
  };
  samples: MetricsSample[];
  capitalFlows?: CapitalFlow[];
  updated: string;
  deployedCommit?: string; // short git hash running when `updated` was written
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

/**
 * The current (mutable, evolves on real capital events) LP/DLMM cost bases — the deposited
 * leg quantities each venue's organic-APR figure is measured against. Used by anything that
 * needs the SAME basis the dashboard's own LP/DLMM P&L cards use (e.g. the capital
 * allocator), rather than re-deriving or guessing it — see pnl-math.js's organicApr() for
 * the formula these bases feed.
 */
export function loadVenueBases(): { lpBasis?: MetricsFile["lpBasis"]; dlmmBasis?: MetricsFile["dlmmBasis"] } {
  const m = load();
  return { lpBasis: m?.lpBasis, dlmmBasis: m?.dlmmBasis };
}

/**
 * Current drawdown of the portfolio (in y) from its high-water mark over the recorded
 * history, as a fraction in [0,1). 0 when at/above the peak or with no history. This is
 * the risk-off signal for defensive allocation — "how far below your best are you now".
 */
//
// Withdrawals are added back before comparing (see withdrawnStx), so taking money out is never
// read as a drawdown: a 700 STX withdrawal is not a trading loss, and must not push the agent
// into its defensive regime.
export function currentDrawdown(portfolioYNow: number, nowT = new Date().toISOString()): number {
  const m = load();
  const hist = m?.samples ?? [];
  if (hist.length === 0 || !(portfolioYNow > 0)) return 0;
  const flows = m?.capitalFlows ?? [];
  const now = portfolioYNow + withdrawnStx(flows, null, nowT);
  const peak = Math.max(now, ...hist.map((s) => s.portfolioY + withdrawnStx(flows, null, s.t)));
  return peak > 0 ? Math.max(0, (peak - now) / peak) : 0;
}

/** Net STX withdrawn (withdrawals minus deposits) in the window (afterT, upToT]. null = open end. */
export function withdrawnStx(flows: CapitalFlow[], afterT: string | null, upToT: string | null): number {
  const a = afterT === null ? -Infinity : Date.parse(afterT);
  const b = upToT === null ? Infinity : Date.parse(upToT);
  return flows.reduce((sum, f) => {
    const t = Date.parse(f.t);
    return t > a && t <= b ? sum - f.stx : sum;
  }, 0);
}

export function loadCapitalFlows(): CapitalFlow[] {
  return load()?.capitalFlows ?? [];
}

/** Records a flow once (deduplicated by txid), keeping the list in time order. */
export function addCapitalFlow(f: CapitalFlow): "added" | "exists" {
  const m = load();
  if (!m) throw new Error(`no metrics file at ${METRICS_PATH}`);
  const flows = m.capitalFlows ?? [];
  if (flows.some((x) => x.txid === f.txid)) return "exists";
  flows.push(f);
  flows.sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
  m.capitalFlows = flows;
  writeFileSync(METRICS_PATH, JSON.stringify(m));
  return "added";
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
    // Re-anchors on the FIRST sample ever, and again any time the position goes from empty
    // back to nonzero — a genuine withdraw-then-later-reopen is a new deposit, not a
    // continuation of the old one, and comparing it against a stale basis overstates IL by
    // whatever the price drifted across the whole gap (found 2026-09-22: a position reopened
    // ~2h earlier was being compared against its pilot-start basis from 25 days prior, showing
    // a fabricated -60.8% APR on what was actually a +2h-old, roughly breakeven position). A
    // same-cycle recenter (withdraw immediately followed by re-add) never shows an intervening
    // zero sample, so it correctly does NOT reset the basis — only a REAL gap does.
    const prevDlmmValueY = m.samples.length ? (m.samples[m.samples.length - 1].dlmmValueY ?? 0) : 0;
    if ((!m.dlmmBasis || prevDlmmValueY <= 0) && s.mid > 0 && (s.dlmmValueY ?? 0) > 0) {
      // Same 50/50-by-value fallback as lpBasis. A caller with the real x/y split (e.g.
      // from a historical on-chain read) should seed dlmmBasis directly instead — this
      // auto-init only fires when nothing better has been set yet.
      m.dlmmBasis = { xQty: s.dlmmValueY! / 2 / s.mid, yQty: s.dlmmValueY! / 2, t: s.t };
    }
    m.samples.push(s);
    if (m.samples.length > MAX_SAMPLES) m.samples = m.samples.slice(-MAX_SAMPLES);
    m.updated = s.t;
    m.deployedCommit = deployedCommit();
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
  // Re-anchor the LP basis to the position as it stands NOW, so LP P&L measures fees-net-IL
  // earned DURING the pilot — not dragged by the pre-pilot ramp. Same reason uptime/IL reset.
  if (s.lpValueY > 0 && s.mid > 0) m.lpBasis = { xQty: s.lpValueY / 2 / s.mid, yQty: s.lpValueY / 2, t: s.t };
  if (s.dlmmValueY && s.dlmmValueY > 0 && s.mid > 0 && !m.dlmmBasis) {
    m.dlmmBasis = { xQty: s.dlmmValueY / 2 / s.mid, yQty: s.dlmmValueY / 2, t: s.t };
  }
  // Fixed snapshot for hodlNow()/pnl.ts's "hold the original pilot-start basket" comparison —
  // see the pilotBaseline type's doc comment for why this must NOT be the same object as the
  // top-level lpBasis/dlmmBasis, which are meant to evolve with real capital events.
  if (m.lpBasis) m.pilotBaseline.lpBasis = { xQty: m.lpBasis.xQty, yQty: m.lpBasis.yQty };
  if (m.dlmmBasis) m.pilotBaseline.dlmmBasis = { xQty: m.dlmmBasis.xQty, yQty: m.dlmmBasis.yQty };
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

/**
 * Explicitly set (or clear) the DLMM cost basis right after a confirmed fresh open — called
 * by the code that just broadcast the transaction and knows the exact deposited legs, instead
 * of relying on recordSample()'s passive reset-on-reopen (which only fires if some cycle's
 * sample happens to observe the position at zero in between). A manual withdraw-then-reopen
 * done faster than one cycle interval never produces that zero sample, so the old basis
 * silently persists against a completely different position — found 2026-09-30: a $150 basis
 * left in place after a withdraw-then-$600-reopen, producing a fabricated +14,330% APR. This
 * does NOT apply to a routine same-capital recenter (withdraw + immediate re-add of the same
 * position, repositioned to new bins) — that correctly keeps the existing basis, since no new
 * capital entered; only a genuine fresh open (first-ever, or a deliberate resize) should reset it.
 */
export function setDlmmBasis(basis: { xQty: number; yQty: number; t: string } | null): void {
  try {
    const m = load();
    if (!m) return;
    if (basis) m.dlmmBasis = basis;
    else delete m.dlmmBasis;
    writeFileSync(METRICS_PATH, JSON.stringify(m));
  } catch (err) {
    console.warn(`(dlmm basis update skipped: ${(err as Error).message})`);
  }
}
