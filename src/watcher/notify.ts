// Alert delivery: Slack incoming webhook, a generic JSON webhook, and a healthchecks.io-style
// heartbeat. With no channel configured, alerts are printed to stdout marked DRY-RUN.
//
// Payloads are built ONLY from public on-chain data (addresses, txids, amounts) and the
// watcher's own rule names — never from env or config. Webhook URLs are themselves secrets
// (anyone holding one can post to the channel), so every log line goes through redact().

import { maxSeverity, type Alert } from "./watcher.js";
import type { Network } from "./allowlist.js";

type Fetch = typeof fetch;

export interface Channels {
  slack?: string;
  webhook?: string;
  heartbeat?: string;
}

/** "https://hooks.slack.com/services/T0/B0/xyz" → "https://hooks.slack.com/…(redacted)". */
export function redactUrl(u: string): string {
  try {
    return `${new URL(u).origin}/…(redacted)`;
  } catch {
    return "(redacted)";
  }
}

/** Replace every configured secret URL in `text` with its redacted form. */
export function redact(text: string, ch: Channels): string {
  let out = text;
  for (const s of [ch.slack, ch.webhook, ch.heartbeat]) if (s) out = out.split(s).join(redactUrl(s));
  return out;
}

const explorer = (txid: string, network: Network) => `https://explorer.hiro.so/txid/${txid}?chain=${network}`;

export function formatText(alerts: Alert[], network: Network): string {
  const sev = maxSeverity(alerts);
  const lines = [`[${sev}] DeepStack wallet watcher (${network}): ${alerts.length} alert${alerts.length === 1 ? "" : "s"}`];
  const order = ["CRITICAL", "HIGH", "INFO"] as const;
  for (const s of order) {
    const group = alerts.filter((a) => a.severity === s);
    // INFO is summarised, not listed one by one: count by rule plus the first few.
    if (s === "INFO" && group.length > 5) {
      const byRule: Record<string, number> = {};
      for (const a of group) byRule[a.rule] = (byRule[a.rule] ?? 0) + 1;
      lines.push(`INFO: ${Object.entries(byRule).map(([r, n]) => `${r} ×${n}`).join(", ")}`);
      continue;
    }
    for (const a of group) lines.push(`${a.severity} ${a.rule} ${a.address}: ${a.summary}${a.txid ? ` ${explorer(a.txid, network)}` : ""}`);
  }
  return lines.join("\n");
}

export function jsonPayload(alerts: Alert[], network: Network) {
  return {
    source: "deepstack-wallet-watcher",
    network,
    severity: maxSeverity(alerts),
    alerts: alerts.map((a) => ({ severity: a.severity, rule: a.rule, address: a.address, txid: a.txid, summary: a.summary, explorer: a.txid ? explorer(a.txid, network) : undefined })),
  };
}

async function post(doFetch: Fetch, url: string, body: unknown): Promise<void> {
  const res = await doFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export interface DeliveryResult {
  dryRun: boolean;
  delivered: boolean; // at least one channel accepted it (or dry-run)
  failures: string[]; // redacted
}

export async function deliver(alerts: Alert[], network: Network, ch: Channels, doFetch: Fetch = fetch, log: (s: string) => void = console.log): Promise<DeliveryResult> {
  if (!alerts.length) return { dryRun: !ch.slack && !ch.webhook, delivered: true, failures: [] };
  const text = formatText(alerts, network);
  if (!ch.slack && !ch.webhook) {
    log(`--- DRY-RUN (no SLACK_WEBHOOK_URL / WATCH_WEBHOOK_URL configured) — would send: ---\n${text}\n--- end DRY-RUN ---`);
    return { dryRun: true, delivered: true, failures: [] };
  }
  const failures: string[] = [];
  let ok = 0;
  const targets: [string, string, unknown][] = [];
  if (ch.slack) targets.push(["slack", ch.slack, { text }]);
  if (ch.webhook) targets.push(["webhook", ch.webhook, jsonPayload(alerts, network)]);
  for (const [name, url, body] of targets) {
    try {
      await post(doFetch, url, body);
      ok++;
    } catch (err) {
      failures.push(redact(`${name} ${redactUrl(url)}: ${(err as Error).message}`, ch));
    }
  }
  return { dryRun: false, delivered: ok > 0, failures };
}

/** Heartbeat ping: GET <url> on a healthy poll, GET <url>/fail on a failing one. Never throws. */
export async function heartbeat(status: "ok" | "fail", ch: Channels, doFetch: Fetch = fetch): Promise<boolean> {
  if (!ch.heartbeat) return false;
  try {
    const url = status === "fail" ? `${ch.heartbeat.replace(/\/$/, "")}/fail` : ch.heartbeat;
    const res = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false; // the missed ping is itself the alert
  }
}
