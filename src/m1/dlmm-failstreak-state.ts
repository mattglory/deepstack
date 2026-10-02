// Persistence for the DLMM restart-survival counters (dlmmFailStreak, dlmmRecenters — see
// agent.ts's nextDlmmCounters/dlmmLiveGate). Extracted to its own file, separate from
// agent-cli.ts, so the load/save contract is unit-testable: agent-cli.ts runs main()
// unconditionally at import time, so no test can import it directly without starting the
// live agent (external review, issue #7).
//
// Config: DLMM_FAILSTREAK_STATE_PATH, default journal/dlmm-failstreak.json. A human clears
// dlmmFailStreak by deleting this file (or editing it) and restarting — see PILOT_DEPLOY.md.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DlmmCounters } from "./agent.js";

export function dlmmFailstreakStatePath(): string {
  return process.env.DLMM_FAILSTREAK_STATE_PATH ?? "journal/dlmm-failstreak.json";
}

export function loadDlmmCounters(path: string = dlmmFailstreakStatePath()): DlmmCounters {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const fs = j?.dlmmFailStreak;
    const rc = j?.dlmmRecenters;
    return { failStreak: typeof fs === "number" && fs >= 0 ? fs : 0, recenters: typeof rc === "number" && rc >= 0 ? rc : 0 };
  } catch {
    return { failStreak: 0, recenters: 0 };
  }
}

export function saveDlmmCounters(state: DlmmCounters, path: string = dlmmFailstreakStatePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ dlmmFailStreak: state.failStreak, dlmmRecenters: state.recenters }));
  } catch {
    /* best-effort — a write failure here must not take the agent down */
  }
}
