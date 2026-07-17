// Decision journal — tick-by-tick audit trail (adopted from the Hummingbot
// Trading Agents Standard's journal/snapshot pattern, simplified).
//
// Every agent tick appends one JSON line: what was observed, what the safety
// gate said, what was decided and why, what the AI tuner set (when it ran),
// and what happened on-chain. Local evidence, gitignored — excerpts are
// published in the pilot results post; the chain remains the public record.
//
// Also here: the dead-man's-switch ping. If HEALTHCHECK_URL is set (e.g. a
// healthchecks.io check), the agent pings it every tick — if pings stop, you
// get alerted within minutes instead of discovering a dead agent days later.
// Protects the pilot's 95% uptime requirement.

import { appendFileSync, mkdirSync } from "node:fs";

const JOURNAL_DIR = process.env.JOURNAL_DIR ?? "journal";

export function appendJournal(entry: Record<string, unknown>): void {
  try {
    mkdirSync(JOURNAL_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10); // one file per day
    appendFileSync(`${JOURNAL_DIR}/${day}.jsonl`, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Evidence, not safety-critical — never take the agent down over it.
    console.warn(`(journal write skipped: ${(err as Error).message})`);
  }
}

/**
 * Dead-man's-switch ping.
 *
 * "ok" (default) reports a completed cycle. "fail" reports a cycle that threw — a live
 * process that cannot read the market is not healthy, and silence would only surface it
 * after the check's grace period. healthchecks.io treats a /fail ping as an immediate
 * alert, so a broken agent is loud rather than merely quiet.
 */
export async function pingHealthcheck(status: "ok" | "fail" = "ok"): Promise<void> {
  const url = process.env.HEALTHCHECK_URL;
  if (!url) return; // graceful no-op until configured
  try {
    await fetch(status === "fail" ? `${url.replace(/\/$/, "")}/fail` : url, { method: "GET" });
  } catch {
    // Alerting outage must not affect trading; the missed ping IS the alert.
  }
}
