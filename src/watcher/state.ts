// Watcher state file: atomic writes (tmp + rename) and a corrupt-file policy that neither
// floods nor hides alerts.
//
// Missing file  → first run: every address is baselined (history counted, not alerted).
// Corrupt file  → the file is MOVED ASIDE (kept as evidence, never overwritten), the caller
//                 raises a HIGH alert, and the poll runs in recovery mode: confirmed txs from
//                 the last WATCH_RECOVERY_HOURS are classified and alerted (HIGH/CRITICAL),
//                 older history is baselined. Silently resetting to "seen nothing" would
//                 either replay the whole history as alerts or, if baselined, hide whatever
//                 happened while the state was broken; the window is the middle ground. Cost:
//                 alerts already sent inside the window may repeat once.
// Unreadable    → (permissions etc.) throw: that is an operator problem, not a reset.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emptyState, type WatcherState } from "./watcher.js";
import type { Network } from "./allowlist.js";

export type LoadResult =
  | { kind: "ok"; state: WatcherState }
  | { kind: "missing"; state: WatcherState }
  | { kind: "corrupt"; state: WatcherState; movedTo: string; reason: string };

function validate(j: any, network: Network): WatcherState {
  if (!j || typeof j !== "object") throw new Error("not an object");
  if (j.version !== 1) throw new Error(`unknown version ${j.version}`);
  if (j.network !== network) throw new Error(`state is for ${j.network}, watcher is on ${network}`);
  if (!j.addresses || typeof j.addresses !== "object") throw new Error("addresses missing");
  for (const [a, s] of Object.entries<any>(j.addresses)) {
    if (typeof s?.lastHeight !== "number" || !Array.isArray(s.seen) || typeof s.balances !== "object") throw new Error(`bad entry for ${a}`);
    for (const v of Object.values(s.balances)) BigInt(v as string); // throws on garbage
  }
  if (!Array.isArray(j.alerted) || typeof j.consecutiveFailures !== "number") throw new Error("alerted/consecutiveFailures missing");
  return { outbox: [], monitoringAlerted: false, ...j } as WatcherState;
}

export function loadState(path: string, network: Network, now = Date.now()): LoadResult {
  if (!existsSync(path)) return { kind: "missing", state: emptyState(network) };
  const raw = readFileSync(path, "utf8"); // unreadable → throws (deliberately)
  try {
    return { kind: "ok", state: validate(JSON.parse(raw), network) };
  } catch (err) {
    const movedTo = `${path}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
    renameSync(path, movedTo);
    return { kind: "corrupt", state: emptyState(network), movedTo, reason: (err as Error).message };
  }
}

/** Write via a temp file + rename so a crash mid-write never leaves a half-written state. */
export function saveState(path: string, state: WatcherState): void {
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 1) + "\n");
  renameSync(tmp, path);
}
