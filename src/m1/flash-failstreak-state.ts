// Persistence for the autonomous flash-rebalance restart-survival counters (flashFailStreak,
// flashAttempts — see agent.ts's nextFlashCounters/flashLiveGate). Same shape as
// dlmm-failstreak-state.ts, separate file for the same reason: agent-cli.ts runs main()
// unconditionally at import time, so no test can import it directly without starting the
// live agent.
//
// Config: FLASH_FAILSTREAK_STATE_PATH, default journal/flash-failstreak.json. A human clears
// flashFailStreak by deleting this file (or editing it) and restarting.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FlashCounters } from "./agent.js";

export function flashFailstreakStatePath(): string {
  return process.env.FLASH_FAILSTREAK_STATE_PATH ?? "journal/flash-failstreak.json";
}

// Fail closed (C7, DSA-13): a missing file is a fresh install and reads as {0, 0}, but a
// file that EXISTS and cannot be read, parsed or validated reads as TRIPPED. It used to reset
// to {0, 0}, which silently re-armed broadcasts that the breaker had stopped "until a human
// clears it". The tripped value is >= any FLASH_FAIL_STREAK_LIMIT, so the live gate's
// `failStreak < limit` term is false and no broadcast is attempted (so nothing overwrites
// the bad file either). A human clears it the same way as a real trip: delete the file.
export const TRIPPED_FAIL_STREAK = Number.MAX_SAFE_INTEGER;

export function loadFlashCounters(path: string = flashFailstreakStatePath()): FlashCounters {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { failStreak: 0, attempts: 0 };
    return tripped(path, (e as Error).message);
  }
  try {
    const j = JSON.parse(raw);
    const fs = j?.flashFailStreak;
    const n = j?.flashAttempts;
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
    if (!ok(fs) || !ok(n)) return tripped(path, "missing or invalid counter fields");
    return { failStreak: fs, attempts: n };
  } catch (e) {
    return tripped(path, (e as Error).message);
  }
}

function tripped(path: string, why: string): FlashCounters {
  console.error(`⛔ FLASH BREAKER STATE UNREADABLE (${path}: ${why}) — treating as TRIPPED; FLASH broadcasts stopped until a human inspects and deletes the file`);
  return { failStreak: TRIPPED_FAIL_STREAK, attempts: 0, corrupt: true };
}

export function saveFlashCounters(state: FlashCounters, path: string = flashFailstreakStatePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Atomic (temp file + rename): a crash or full disk mid-write leaves the previous file,
    // never a half-written one.
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ flashFailStreak: state.failStreak, flashAttempts: state.attempts }));
    renameSync(tmp, path);
  } catch (e) {
    // Must not take the agent down, but must be visible: the in-memory counter still holds.
    console.error(`⛔ flash breaker state NOT saved (${path}): ${(e as Error).message}`);
  }
}
