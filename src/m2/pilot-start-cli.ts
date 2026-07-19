// Open the official 30-day pilot window — run ON the pilot box, once.
//
//   npm run m2:pilot-start                # preview: what would be anchored
//   npm run m2:pilot-start -- --confirm   # anchor it (irreversible by design)
//
// Anchors pilotStartedAt + the HODL baseline at the latest telemetry sample. From that
// moment the dashboard's uptime, IL-adjusted return, and price chart scope to the pilot
// window, and `m2:pnl` defaults its --since to it. Preconditions (checked by the
// operator, not the tool): funding complete, inventory pre-split done, agent green for
// a week. A second run refuses — evidence windows are not renegotiable mid-run.

import { readFileSync } from "node:fs";
import { markPilotStart, METRICS_PATH } from "../m1/metrics.js";

const confirm = process.argv.includes("--confirm");

const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
if (m.pilotStartedAt) {
  console.log(`pilot window already open since ${m.pilotStartedAt} — nothing to do`);
  process.exit(0);
}
const last = m.samples?.[m.samples.length - 1];
if (!last) { console.error("no telemetry yet — run a cycle first"); process.exit(1); }

console.log(`would anchor the pilot window at the latest sample:`);
console.log(`  t: ${last.t}`);
console.log(`  portfolio: ${last.portfolioY.toFixed(2)} STX | mid: ${last.mid.toFixed(0)}`);
console.log(`  HODL baseline: ${last.xBase} xBase + ${last.yBase} yBase\n`);

if (!confirm) { console.log("preview only — add --confirm to open the window (once, irreversibly)"); process.exit(0); }

const r = markPilotStart();
console.log(`🏁 pilot window OPEN since ${r.startedAt} at ${r.portfolioY.toFixed(2)} STX.`);
console.log(`30 days ends ${new Date(Date.parse(r.startedAt) + 30 * 864e5).toISOString().slice(0, 10)}.`);
console.log(`Report anytime: bash deploy/watch.sh report`);
