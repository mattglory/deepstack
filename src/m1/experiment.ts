// Bounded pre-pilot BAND EXPERIMENT — pin a tight rebalance band and measure what it costs
// LIVE, with hard auto-revert guardrails. OFF by default (EXPERIMENT_BAND_MODE unset).
//
// This is explicitly NOT the formal pilot. It runs during the pre-pilot shakedown to learn
// empirically what the band-cost.mjs model predicts (a tight band on a full-range XYK pool is
// value-destroying), declared openly in EXPERIMENT.md. The professional-standard point is that
// the downside is BOUNDED three independent ways — a rebalance-count cap, a cumulative fee-cost
// cap, and a time cap — and the instant any trips, the band auto-reverts to the measured
// vol-scaled band and the experiment ends for good. State persists to a JSON file so a VPS
// restart cannot silently reset the counters (a guardrail that resets is no guardrail).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ExperimentConfig {
  mode: boolean;
  bandBps: number; // the tight experimental band the experiment pins
  maxRebalances: number;
  maxCostStx: number;
  maxDays: number;
  statePath: string;
}

export interface ExperimentState {
  startedAt: string | null; // ISO of the first active cycle; null until then
  rebalances: number;
  costStx: number; // cumulative swap fees spent by experiment rebalances
  ended: boolean;
  endReason: string | null;
}

export function defaultExperimentConfig(): ExperimentConfig {
  return {
    mode: /^(1|true|on)$/i.test(process.env.EXPERIMENT_BAND_MODE ?? ""),
    bandBps: Number(process.env.EXPERIMENT_BAND_BPS ?? 50),
    maxRebalances: Number(process.env.EXPERIMENT_MAX_REBALANCES ?? 8),
    maxCostStx: Number(process.env.EXPERIMENT_MAX_COST_STX ?? 8),
    maxDays: Number(process.env.EXPERIMENT_MAX_DAYS ?? 4),
    statePath: process.env.EXPERIMENT_STATE_PATH ?? "journal/experiment.json",
  };
}

export function freshState(): ExperimentState {
  return { startedAt: null, rebalances: 0, costStx: 0, ended: false, endReason: null };
}

export function loadExperimentState(path: string): ExperimentState {
  try {
    return { ...freshState(), ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return freshState();
  }
}

export function saveExperimentState(path: string, s: ExperimentState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* dir exists */
  }
  writeFileSync(path, JSON.stringify(s, null, 2));
}

export interface ExperimentDecision {
  bandBps: number; // the band to use for the rebalance decision this cycle
  active: boolean; // is the experiment currently pinning the band?
  status: string; // human-readable, journalled every cycle
  state: ExperimentState; // startedAt set on first active cycle; ended set when a cap trips
}

/**
 * Pure guardrail decision: given the measured vol band and current state, what band to use
 * this cycle and whether a cap has ended the experiment. Reverts to volBandBps the moment any
 * of the three caps is reached — count first, then cost, then time.
 */
export function experimentDecision(
  cfg: ExperimentConfig,
  state: ExperimentState,
  volBandBps: number,
  nowIso: string,
): ExperimentDecision {
  if (!cfg.mode || state.ended) {
    return {
      bandBps: volBandBps,
      active: false,
      status: state.ended ? `ended: ${state.endReason}` : "off",
      state,
    };
  }
  const startedAt = state.startedAt ?? nowIso;
  const days = (Date.parse(nowIso) - Date.parse(startedAt)) / 86_400_000;
  let endReason: string | null = null;
  if (state.rebalances >= cfg.maxRebalances) endReason = `max rebalances (${cfg.maxRebalances})`;
  else if (state.costStx >= cfg.maxCostStx) endReason = `cost cap (${cfg.maxCostStx} STX)`;
  else if (days >= cfg.maxDays) endReason = `time cap (${cfg.maxDays}d)`;
  if (endReason) {
    return {
      bandBps: volBandBps,
      active: false,
      status: `experiment ENDED — ${endReason}; reverted to vol band ${volBandBps}bps`,
      state: { ...state, startedAt, ended: true, endReason },
    };
  }
  return {
    bandBps: cfg.bandBps,
    active: true,
    status:
      `active: band ${cfg.bandBps}bps | ${state.rebalances}/${cfg.maxRebalances} rebals | ` +
      `${state.costStx.toFixed(2)}/${cfg.maxCostStx} STX | day ${days.toFixed(1)}/${cfg.maxDays}`,
    state: { ...state, startedAt },
  };
}

/** Pure — record an executed experiment rebalance's fee cost. */
export function recordRebalance(state: ExperimentState, feeStx: number): ExperimentState {
  return { ...state, rebalances: state.rebalances + 1, costStx: +(state.costStx + feeStx).toFixed(6) };
}
