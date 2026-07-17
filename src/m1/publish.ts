// Telemetry publisher — gets pilot evidence off the VPS and onto the public dashboard.
//
// The agent writes dashboard/metrics.json locally, but the Vercel dashboard serves
// whatever was deployed last — during the pilot its uptime/heartbeat panels would sit
// frozen, which are exactly the panels that evidence the pilot. Fix: after each cycle,
// push metrics.json to a GitHub gist; the dashboard fetches the gist's raw URL and uses
// whichever copy (same-origin or gist) is fresher.
//
// Why a gist and not `vercel deploy` from the box: this VPS holds a funded wallet key.
// A Vercel token can redeploy every project on the account; a classic PAT with only the
// `gist` scope can edit gists and nothing else. Smallest credential that does the job.
//
// Config (both required, else a graceful no-op):
//   METRICS_GIST_ID     — id of a gist you own, pre-created with a metrics.json file
//   METRICS_GIST_TOKEN  — classic PAT, `gist` scope ONLY

import { readFileSync } from "node:fs";
import { METRICS_PATH } from "./metrics.js";

type Fetch = typeof fetch;

let failStreak = 0;

/**
 * Push the current metrics file to the configured gist. Never throws — telemetry is
 * evidence, not safety-critical, and a GitHub outage must not affect trading. Logs a
 * warning per failure; the dashboard's "stale heartbeat" tile is the durable signal.
 */
export async function publishMetrics(doFetch: Fetch = fetch): Promise<boolean> {
  const id = process.env.METRICS_GIST_ID;
  const token = process.env.METRICS_GIST_TOKEN;
  if (!id || !token) return false; // graceful no-op until configured

  try {
    const content = readFileSync(METRICS_PATH, "utf8");
    const res = await doFetch(`https://api.github.com/gists/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ files: { "metrics.json": { content } } }),
    });
    if (!res.ok) throw new Error(`gist update → HTTP ${res.status}`);
    failStreak = 0;
    return true;
  } catch (err) {
    failStreak++;
    console.warn(`(metrics publish skipped: ${(err as Error).message}` +
      (failStreak > 1 ? `, ${failStreak} in a row)` : ")"));
    return false;
  }
}
