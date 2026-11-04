// Persistence for the DLMM restart-survival counters (dlmmFailStreak, dlmmRecenters — see
// agent.ts's nextDlmmCounters/dlmmLiveGate). Extracted to its own file, separate from
// agent-cli.ts, so the load/save contract is unit-testable: agent-cli.ts runs main()
// unconditionally at import time, so no test can import it directly without starting the
// live agent (external review, issue #7).
//
// Config: DLMM_FAILSTREAK_STATE_PATH, default journal/dlmm-failstreak.json. A human clears
// dlmmFailStreak by deleting this file (or editing it) and restarting — see PILOT_DEPLOY.md.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DlmmCounters } from "./agent.js";

export function dlmmFailstreakStatePath(): string {
  return process.env.DLMM_FAILSTREAK_STATE_PATH ?? "journal/dlmm-failstreak.json";
}

// Fail closed (C7, DSA-13): a missing file is a fresh install and reads as {0, 0}, but a
// file that EXISTS and cannot be read, parsed or validated reads as TRIPPED. It used to reset
// to {0, 0}, which silently re-armed broadcasts that the breaker had stopped "until a human
// clears it". The tripped value is >= any DLMM_FAIL_STREAK_LIMIT, so the live gate's
// `failStreak < limit` term is false and no broadcast is attempted (so nothing overwrites
// the bad file either). A human clears it the same way as a real trip: delete the file.
export const TRIPPED_FAIL_STREAK = Number.MAX_SAFE_INTEGER;

export function loadDlmmCounters(path: string = dlmmFailstreakStatePath()): DlmmCounters {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { failStreak: 0, recenters: 0 };
    return tripped(path, (e as Error).message);
  }
  try {
    const j = JSON.parse(raw);
    const fs = j?.dlmmFailStreak;
    const n = j?.dlmmRecenters;
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
    if (!ok(fs) || !ok(n)) return tripped(path, "missing or invalid counter fields");
    return { failStreak: fs, recenters: n };
  } catch (e) {
    return tripped(path, (e as Error).message);
  }
}

function tripped(path: string, why: string): DlmmCounters {
  console.error(`⛔ DLMM BREAKER STATE UNREADABLE (${path}: ${why}) — treating as TRIPPED; DLMM broadcasts stopped until a human inspects and deletes the file`);
  return { failStreak: TRIPPED_FAIL_STREAK, recenters: 0, corrupt: true };
}

export function saveDlmmCounters(state: DlmmCounters, path: string = dlmmFailstreakStatePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Atomic (temp file + rename): a crash or full disk mid-write leaves the previous file,
    // never a half-written one.
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ dlmmFailStreak: state.failStreak, dlmmRecenters: state.recenters }));
    renameSync(tmp, path);
  } catch (e) {
    // Must not take the agent down, but must be visible: the in-memory counter still holds.
    console.error(`⛔ dlmm breaker state NOT saved (${path}): ${(e as Error).message}`);
  }
}
