// Persistence for the autonomous flash-rebalance restart-survival counters (flashFailStreak,
// flashAttempts — see agent.ts's nextFlashCounters/flashLiveGate). Same shape as
// dlmm-failstreak-state.ts, separate file for the same reason: agent-cli.ts runs main()
// unconditionally at import time, so no test can import it directly without starting the
// live agent.
//
// Config: FLASH_FAILSTREAK_STATE_PATH, default journal/flash-failstreak.json. A human clears
// flashFailStreak by deleting this file (or editing it) and restarting.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FlashCounters } from "./agent.js";

export function flashFailstreakStatePath(): string {
  return process.env.FLASH_FAILSTREAK_STATE_PATH ?? "journal/flash-failstreak.json";
}

export function loadFlashCounters(path: string = flashFailstreakStatePath()): FlashCounters {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const fs = j?.flashFailStreak;
    const at = j?.flashAttempts;
    return { failStreak: typeof fs === "number" && fs >= 0 ? fs : 0, attempts: typeof at === "number" && at >= 0 ? at : 0 };
  } catch {
    return { failStreak: 0, attempts: 0 };
  }
}

export function saveFlashCounters(state: FlashCounters, path: string = flashFailstreakStatePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ flashFailStreak: state.failStreak, flashAttempts: state.attempts }));
  } catch {
    /* best-effort — a write failure here must not take the agent down */
  }
}
