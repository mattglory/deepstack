// The manual kill switch, in one place (C8 / DSA-27, assessment A4 F-16).
//
// Before: each call site used existsSync("KILL"), relative to the process cwd, so a CLI run
// from another directory did not see /opt/deepstack/KILL, and existsSync reads a stat error
// (EACCES, ENOTDIR, ...) as "no file", i.e. not killed.
//
// Now: the file is resolved absolutely, from APP_DIR when set, otherwise from this module's
// location (src/m1/kill.ts -> the app root). Under systemd that is /opt/deepstack, the same
// directory as WorkingDirectory=, so the documented `touch /opt/deepstack/KILL` is unchanged.
// The old cwd-relative "KILL" is still honoured by isKilled(), so nothing that halted the agent
// before stops halting it now.

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Absolute path of the KILL file. */
export function killPath(): string {
  return join(process.env.APP_DIR ? resolve(process.env.APP_DIR) : APP_ROOT, "KILL");
}

function stat(path: string): "present" | "absent" | "error" {
  try {
    statSync(path);
    return "present";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "error";
  }
}

/**
 * Should the agent stop broadcasting? KILL_SWITCH=1, or a KILL file in the app directory or the
 * cwd. A stat error other than ENOENT counts as killed (fail closed). Call it immediately before
 * every broadcast, not just once per cycle, so a halt also stops a multi-step sequence.
 */
export function isKilled(): boolean {
  if (process.env.KILL_SWITCH === "1") return true;
  return stat(killPath()) !== "absent" || stat(resolve("KILL")) !== "absent";
}

/**
 * For operator CLIs that broadcast from the agent wallet and must only run while the agent is
 * paused: true only when the app directory's KILL file positively exists. An unreadable path
 * does not prove the agent is paused, so the CLI refuses.
 */
export function killFilePresent(): boolean {
  return stat(killPath()) === "present";
}
