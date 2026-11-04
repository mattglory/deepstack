// One watcher poll end to end: load state → read sources → evaluate → deliver → heartbeat →
// save. Separate from cli.ts so tests can drive it with a mock fetch and a temp state file.

import { defaultAllowlist, AGENT_WALLET, type Network } from "./allowlist.js";
import { HiroSource, chainTip, defaultApi, observeAddress } from "./sources.js";
import { loadState, saveState } from "./state.js";
import { deliver, heartbeat, redact, type Channels } from "./notify.js";
import { SEVERITY_RANK, evaluatePoll, type Alert, type Observation, type Rules, type Severity, type WatcherState } from "./watcher.js";

type Fetch = typeof fetch;

export interface WatchConfig {
  network: Network;
  addresses: string[];
  endpoints: string[];
  timeoutMs: number;
  statePath: string;
  channels: Channels;
  owners: string[];
  extraContracts: string[];
  largeMovePct: number;
  balanceDropPct: number;
  failedBurst: number;
  failAfter: number; // consecutive all-sources-failed polls before a monitoring alert
  notifyMin: Severity;
  recoveryHours: number;
  maxPages: number;
}

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const num = (s: string | undefined, d: number) => {
  if (s === undefined || s === "") return d;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a non-negative number: ${s}`);
  return n;
};

/** Config from env (flags are folded into env by cli.ts). */
export function loadConfig(env: Record<string, string | undefined> = process.env): WatchConfig {
  const network = (env.WATCH_NETWORK ?? "mainnet") as Network;
  if (network !== "mainnet" && network !== "testnet") throw new Error(`WATCH_NETWORK must be mainnet|testnet, got ${network}`);
  const notifyMin = (env.WATCH_NOTIFY_MIN ?? "HIGH").toUpperCase() as Severity;
  if (!(notifyMin in SEVERITY_RANK)) throw new Error(`WATCH_NOTIFY_MIN must be INFO|HIGH|CRITICAL`);
  const addresses = list(env.WATCH_ADDRESSES);
  if (!addresses.length && network === "testnet") throw new Error("WATCH_ADDRESSES is required on testnet");
  return {
    network,
    addresses: addresses.length ? addresses : [AGENT_WALLET],
    endpoints: [env.WATCH_API || defaultApi(network), ...list(env.WATCH_API_FALLBACKS)],
    timeoutMs: num(env.WATCH_TIMEOUT_MS, 10_000),
    statePath: env.WATCH_STATE_PATH || "watcher-state.json",
    channels: { slack: env.SLACK_WEBHOOK_URL || undefined, webhook: env.WATCH_WEBHOOK_URL || undefined, heartbeat: env.WATCH_HEARTBEAT_URL || undefined },
    owners: list(env.OWNER_ALLOWLIST),
    extraContracts: list(env.WATCH_CONTRACT_ALLOWLIST),
    largeMovePct: num(env.WATCH_LARGE_MOVE_PCT, 25),
    balanceDropPct: num(env.WATCH_BALANCE_DROP_PCT, 10),
    failedBurst: num(env.WATCH_FAILED_BURST, 3),
    failAfter: num(env.WATCH_FAIL_AFTER, 3),
    notifyMin,
    recoveryHours: num(env.WATCH_RECOVERY_HOURS, 24),
    maxPages: num(env.WATCH_MAX_PAGES, 3),
  };
}

export function buildRules(c: WatchConfig): Rules {
  const allow = defaultAllowlist(c.network);
  const calls = new Set([...allow.filter((e) => e.kind === "call").map((e) => e.id), ...c.extraContracts]);
  return {
    network: c.network,
    watched: c.addresses,
    owners: new Set(c.owners),
    calls,
    counterparties: new Set([...allow.map((e) => e.id), ...c.extraContracts]),
    largeMovePct: c.largeMovePct,
    balanceDropPct: c.balanceDropPct,
    failedBurst: c.failedBurst,
  };
}

export interface PollOutcome {
  healthy: boolean;
  alerts: Alert[]; // everything new this poll (all severities), incl. retried outbox
  notified: boolean; // a notification went out (or would have, in dry-run)
  dryRun: boolean;
  state: WatcherState;
  error?: string;
}

// Always delivered even when below WATCH_NOTIFY_MIN: they are about the watcher itself.
const ALWAYS_NOTIFY = new Set(["state-corrupt", "monitoring-recovered", "test-alert"]);

export async function runPoll(c: WatchConfig, doFetch: Fetch = fetch, log: (s: string) => void = console.log, now = Date.now()): Promise<PollOutcome> {
  const loaded = loadState(c.statePath, c.network, now);
  let state = loaded.state;
  const pre: Alert[] = [];
  if (loaded.kind === "corrupt") {
    state.recoverSince = now - c.recoveryHours * 3_600_000;
    pre.push({ key: `state-corrupt:${now}`, severity: "HIGH", rule: "state-corrupt", address: "-", summary: `state file was corrupt (${loaded.reason}); moved to ${loaded.movedTo}. Recovering: txs from the last ${c.recoveryHours}h are re-checked (alerts in that window may repeat), older history is baselined.` });
  }

  const src = new HiroSource(c.endpoints, c.timeoutMs, doFetch, (s) => log(redact(s, c.channels)));
  let observations: Observation[] | undefined;
  let error: string | undefined;
  try {
    const tip = await chainTip(src);
    observations = [];
    for (const a of c.addresses) observations.push(await observeAddress(src, a, tip, state.addresses[a]?.lastHeight ?? 0, c.maxPages));
  } catch (err) {
    error = redact((err as Error).message, c.channels);
  }

  let fresh: Alert[] = [];
  let monitoringFail = false;
  if (!observations) {
    state = { ...state, consecutiveFailures: state.consecutiveFailures + 1 };
    log(`  [watch] all sources failed (${state.consecutiveFailures} in a row): ${error}`);
    if (state.consecutiveFailures >= c.failAfter) {
      monitoringFail = true;
      if (!state.monitoringAlerted) {
        pre.push({ key: `monitoring-failure:${now}`, severity: "HIGH", rule: "monitoring-failure", address: "-", summary: `watcher could not read the chain for ${state.consecutiveFailures} consecutive polls (last error: ${error}). The wallet is UNWATCHED until this clears.` });
        state.monitoringAlerted = true;
      }
    }
  } else {
    const res = evaluatePoll(state, observations, buildRules(c), { recoverSince: state.recoverSince });
    if (state.monitoringAlerted) {
      pre.push({ key: `monitoring-recovered:${now}`, severity: "INFO", rule: "monitoring-recovered", address: "-", summary: `watcher reading the chain again after ${state.consecutiveFailures} failed polls` });
    }
    state = { ...res.state, consecutiveFailures: 0, monitoringAlerted: false, recoverSince: undefined, lastOkAt: new Date(now).toISOString() };
    fresh = res.alerts;
  }

  const all = [...state.outbox, ...pre, ...fresh];
  for (const a of all) log(`  ${a.severity.padEnd(8)} ${a.rule.padEnd(22)} ${a.address} ${a.txid ?? ""} ${a.summary}`);
  const notifiable = all.filter((a) => SEVERITY_RANK[a.severity] >= SEVERITY_RANK[c.notifyMin] || ALWAYS_NOTIFY.has(a.rule));
  let notified = false;
  let dryRun = !c.channels.slack && !c.channels.webhook;
  let deliveryFailed = false;
  if (notifiable.length) {
    // INFO rides along (summarised) once there is something worth sending.
    const d = await deliver(all, c.network, c.channels, doFetch, log);
    dryRun = d.dryRun;
    notified = d.delivered;
    for (const f of d.failures) log(`  [watch] delivery failed: ${f}`);
    deliveryFailed = d.failures.length > 0;
    state.outbox = d.delivered ? [] : notifiable;
  } else {
    state.outbox = [];
  }

  const healthy = Boolean(observations) && !deliveryFailed;
  if (healthy) await heartbeat("ok", c.channels, doFetch);
  else if (monitoringFail || deliveryFailed) await heartbeat("fail", c.channels, doFetch);
  saveState(c.statePath, state);
  return { healthy, alerts: [...pre, ...fresh], notified, dryRun, state, error };
}

/** --test-alert: one INFO message through every configured channel, plus a heartbeat ping. */
export async function sendTestAlert(c: WatchConfig, doFetch: Fetch = fetch, log: (s: string) => void = console.log): Promise<boolean> {
  const alert: Alert = { key: `test-alert:${Date.now()}`, severity: "INFO", rule: "test-alert", address: c.addresses.join(","), summary: "test message from the DeepStack wallet watcher — delivery works. No action needed." };
  const d = await deliver([alert], c.network, c.channels, doFetch, log);
  for (const f of d.failures) log(`  delivery failed: ${f}`);
  if (!d.dryRun) {
    if (c.channels.slack) log(`  slack:   ${d.failures.some((f) => f.startsWith("slack")) ? "FAILED" : "sent"}`);
    if (c.channels.webhook) log(`  webhook: ${d.failures.some((f) => f.startsWith("webhook")) ? "FAILED" : "sent"}`);
  }
  if (c.channels.heartbeat) log(`  heartbeat: ${(await heartbeat("ok", c.channels, doFetch)) ? "ok" : "FAILED"}`);
  return d.failures.length === 0;
}
