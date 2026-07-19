// Pilot P&L report from local evidence — journal/*.jsonl + dashboard/metrics.json.
//
//   npm run m2:pnl                          # whole recorded history
//   npm run m2:pnl -- --since 2026-09-01    # the pilot window
//   npm run m2:pnl -- --since 2026-09-01 --until 2026-10-01
//
// Prints the results-post tables (markdown). Everything is regenerable from the same
// files, so the post's numbers are auditable rather than asserted. Note: P&L-vs-HODL is
// only meaningful over a window with no external capital changes (fund BEFORE the
// window opens, never during).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { buildReport, renderMarkdown, type TickRecord, type MetricsSampleLite } from "./pnl.js";
import { METRICS_PATH } from "../m1/metrics.js";

const JOURNAL_DIR = process.env.JOURNAL_DIR ?? "journal";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function loadJournal(): TickRecord[] {
  if (!existsSync(JOURNAL_DIR)) return [];
  const out: TickRecord[] = [];
  for (const f of readdirSync(JOURNAL_DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(`${JOURNAL_DIR}/${f}`, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as TickRecord;
        // Journal ticks use "YYYY-MM-DD HH:MM:SS"; normalise to ISO-ish for comparisons.
        e.t = (e.t ?? "").replace(" ", "T");
        out.push(e);
      } catch { /* skip malformed lines rather than lose the report */ }
    }
  }
  return out;
}

function loadSamples(): { samples: MetricsSampleLite[]; intervalSec: number; pilotStartedAt?: string } {
  try {
    const m = JSON.parse(readFileSync(METRICS_PATH, "utf8"));
    return { samples: m.samples ?? [], intervalSec: m.intervalSec ?? 0, pilotStartedAt: m.pilotStartedAt };
  } catch {
    return { samples: [], intervalSec: 0 };
  }
}

const { samples, intervalSec, pilotStartedAt } = loadSamples();
// The pilot window is the default report window once it exists — pass --since to override.
const since = flag("--since") ?? pilotStartedAt;
const until = flag("--until");
if (!flag("--since") && pilotStartedAt) console.log(`(window: official pilot, since ${pilotStartedAt})\n`);
const report = buildReport(loadJournal(), samples, intervalSec, since, until);
console.log(renderMarkdown(report));
