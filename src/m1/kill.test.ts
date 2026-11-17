// C8 / DSA-27 (assessment A4 F-16): the KILL switch used existsSync("KILL") relative to the
// process cwd (a CLI run from another directory did not see it), and existsSync reads a stat
// error such as EACCES/ENOTDIR as "not killed". These pin the shared helper's contract.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { killPath, isKilled, killFilePresent } from "./kill.js";

let dir: string;
const saved = { APP_DIR: process.env.APP_DIR, KILL_SWITCH: process.env.KILL_SWITCH };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deepstack-kill-test-"));
  process.env.APP_DIR = dir;
  delete process.env.KILL_SWITCH;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("killPath: absolute, under APP_DIR when set", () => {
  assert.equal(killPath(), join(dir, "KILL"));
});

test("killPath: without APP_DIR, the app root derived from the module location (not the cwd)", () => {
  delete process.env.APP_DIR;
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.equal(killPath(), join(appRoot, "KILL"));
});

test("isKilled: no KILL file and no KILL_SWITCH -> not killed", () => {
  assert.equal(isKilled(), false);
});

test("isKilled: KILL file in the app dir -> killed", () => {
  writeFileSync(join(dir, "KILL"), "");
  assert.equal(isKilled(), true);
});

test("isKilled: KILL_SWITCH=1 -> killed", () => {
  process.env.KILL_SWITCH = "1";
  assert.equal(isKilled(), true);
});

test("isKilled: a stat error other than ENOENT (here ENOTDIR) fails closed -> killed", () => {
  const notADir = join(dir, "file");
  writeFileSync(notADir, "");
  process.env.APP_DIR = notADir; // <file>/KILL -> ENOTDIR
  assert.equal(isKilled(), true);
});

test("killFilePresent (operator CLIs that require the agent paused): present only when the file exists", () => {
  assert.equal(killFilePresent(), false);
  writeFileSync(join(dir, "KILL"), "");
  assert.equal(killFilePresent(), true);
});

test("killFilePresent: an unreadable KILL path does not count as 'agent paused' (CLI refuses)", () => {
  const notADir = join(dir, "file");
  writeFileSync(notADir, "");
  process.env.APP_DIR = notADir;
  assert.equal(killFilePresent(), false);
});
