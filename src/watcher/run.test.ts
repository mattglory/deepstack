// End-to-end watcher polls with a mock fetch and a temp state file: state persistence and
// corruption, monitoring-failure alerting, heartbeats, delivery, redaction. Offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureFetch } from "./fixtures/mock-fetch.js";
import { loadConfig, runPoll, sendTestAlert } from "./run.js";
import { loadState, saveState } from "./state.js";
import { deliver, jsonPayload, redact, redactUrl } from "./notify.js";
import { emptyState, type Alert } from "./watcher.js";

const P = "https://primary.example";
const SLACK = "https://hooks.slack.com/services/T000/B000/SECRETTOKENxyz";
const HOOK = "https://alerts.example/hook?token=SECRET2";
const BEAT = "https://hc-ping.example/uuid-SECRET3";
const quiet = () => {};

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "watcher-"));
  const statePath = join(dir, "watcher-state.json");
  const c = loadConfig({ WATCH_API: P, WATCH_STATE_PATH: statePath, WATCH_TIMEOUT_MS: "50", ...env });
  return { dir, statePath, c };
}

/** Wraps the fixture fetch: records POSTs/heartbeats; `postStatus` simulates a broken webhook. */
function harness(opts: { bad?: Record<string, "error" | "hang" | "500">; postStatus?: number } = {}) {
  const inner = fixtureFetch({ bad: opts.bad });
  const posts: { url: string; body: any }[] = [];
  const beats: string[] = [];
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("ok", { status: opts.postStatus ?? 200 });
    }
    if (url.startsWith(BEAT)) {
      beats.push(url.endsWith("/fail") ? "fail" : "ok");
      return new Response("OK");
    }
    return inner.f(input, init);
  }) as typeof fetch;
  return { f, posts, beats };
}

test("state: save is atomic (no tmp left behind) and round-trips", () => {
  const { dir, statePath } = setup();
  const s = emptyState("mainnet");
  s.addresses.SP1 = { lastHeight: 5, seen: ["0x1"], balances: { STX: "10" } };
  saveState(statePath, s);
  assert.deepEqual(readdirSync(dir), ["watcher-state.json"]);
  const l = loadState(statePath, "mainnet");
  assert.equal(l.kind, "ok");
  assert.deepEqual(l.state.addresses.SP1, s.addresses.SP1);
});

test("state: corrupt or wrong-network file is moved aside, never overwritten", () => {
  const { dir, statePath } = setup();
  writeFileSync(statePath, "{ not json");
  const l = loadState(statePath, "mainnet", Date.parse("2026-11-03T00:00:00Z"));
  assert.equal(l.kind, "corrupt");
  assert.ok(!existsSync(statePath));
  assert.equal(readFileSync(l.kind === "corrupt" ? l.movedTo : "", "utf8"), "{ not json");
  saveState(statePath, emptyState("testnet"));
  assert.equal(loadState(statePath, "mainnet").kind, "corrupt");
  assert.equal(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length, 2);
});

test("poll: first run baselines, second run is quiet, heartbeat ok each time", async () => {
  const { c, statePath } = setup({ WATCH_HEARTBEAT_URL: BEAT, WATCH_DRY_RUN: "1" });
  const h = harness();
  const r1 = await runPoll(c, h.f, quiet);
  assert.equal(r1.healthy, true);
  assert.deepEqual(r1.alerts.map((a) => a.rule), ["baseline"]);
  assert.equal(r1.dryRun, true);
  assert.equal(r1.notified, false); // INFO only, below the default HIGH notify floor
  const r2 = await runPoll(c, h.f, quiet);
  assert.deepEqual(r2.alerts, []);
  assert.deepEqual(h.beats, ["ok", "ok"]);
  assert.ok(existsSync(statePath));
});

test("poll: monitoring-failure alert after N consecutive all-source failures, once; recovery noticed", async () => {
  const { c } = setup({ WATCH_HEARTBEAT_URL: BEAT, WATCH_WEBHOOK_URL: HOOK, WATCH_FAIL_AFTER: "3", WATCH_API_FALLBACKS: "https://backup.example" });
  const down = harness({ bad: { [P]: "hang", "https://backup.example": "error" } });
  const rules: string[][] = [];
  for (let i = 0; i < 4; i++) rules.push((await runPoll(c, down.f, quiet)).alerts.map((a) => a.rule));
  assert.deepEqual(rules, [[], [], ["monitoring-failure"], []]);
  assert.deepEqual(down.beats, ["fail", "fail"]); // polls 3 and 4; no ok ping while failing
  assert.equal(down.posts.length, 1);
  assert.equal(down.posts[0].body.severity, "HIGH");
  const up = harness();
  const r = await runPoll(c, up.f, quiet);
  assert.ok(r.alerts.some((a) => a.rule === "monitoring-recovered"));
  assert.equal(r.state.consecutiveFailures, 0);
  assert.deepEqual(up.beats, ["ok"]);
});

test("poll: corrupt state → HIGH alert, file moved aside, watcher resumes and saves fresh state", async () => {
  const { c, statePath, dir } = setup({ WATCH_WEBHOOK_URL: HOOK });
  writeFileSync(statePath, "garbage");
  const h = harness();
  const r = await runPoll(c, h.f, quiet);
  assert.equal(r.healthy, true);
  assert.ok(r.alerts.some((a) => a.rule === "state-corrupt" && a.severity === "HIGH"));
  assert.equal(h.posts.length, 1);
  assert.equal(loadState(statePath, "mainnet").kind, "ok");
  assert.ok(readdirSync(dir).some((f) => f.includes(".corrupt-")));
});

test("poll: failed delivery keeps HIGH alerts in the outbox, pings /fail, retries next poll", async () => {
  const { c, statePath } = setup({ WATCH_WEBHOOK_URL: HOOK, WATCH_HEARTBEAT_URL: BEAT });
  writeFileSync(statePath, "garbage"); // guarantees a HIGH alert to deliver
  const broken = harness({ postStatus: 500 });
  const r1 = await runPoll(c, broken.f, quiet);
  assert.equal(r1.healthy, false);
  assert.deepEqual(broken.beats, ["fail"]);
  assert.equal(r1.state.outbox.length, 1);
  const fixed = harness();
  const r2 = await runPoll(c, fixed.f, quiet);
  assert.equal(fixed.posts.length, 1);
  assert.ok(fixed.posts[0].body.alerts.some((a: any) => a.rule === "state-corrupt"));
  assert.equal(r2.state.outbox.length, 0);
});

test("redaction: webhook URLs never appear in logs or payloads", async () => {
  const ch = { slack: SLACK, webhook: HOOK, heartbeat: BEAT };
  assert.equal(redactUrl(SLACK), "https://hooks.slack.com/…(redacted)");
  assert.ok(!redact(`failed posting to ${SLACK} and ${HOOK}`, ch).match(/SECRET/));
  const logs: string[] = [];
  const { c } = setup({ SLACK_WEBHOOK_URL: SLACK, WATCH_WEBHOOK_URL: HOOK, WATCH_HEARTBEAT_URL: BEAT, WATCH_NOTIFY_MIN: "INFO" });
  const h = harness({ postStatus: 403 });
  await runPoll(c, h.f, (s) => logs.push(s));
  assert.ok(logs.some((l) => l.includes("delivery failed")));
  assert.ok(!logs.join("\n").includes("SECRET"), logs.join("\n"));
  assert.ok(!JSON.stringify(h.posts.map((p) => p.body)).includes("SECRET"));
});

test("delivery: DRY-RUN prints clearly marked output when no channel is configured", async () => {
  const out: string[] = [];
  const a: Alert = { key: "k", severity: "CRITICAL", rule: "deploy", address: "SP1", txid: "0xabc", summary: "x" };
  const d = await deliver([a], "mainnet", {}, (() => assert.fail("no network in dry-run")) as any, (s) => out.push(s));
  assert.equal(d.dryRun, true);
  assert.match(out.join("\n"), /^--- DRY-RUN/);
  assert.deepEqual(Object.keys(jsonPayload([a], "mainnet")), ["source", "network", "severity", "alerts"]);
});

test("no alert channel and no WATCH_DRY_RUN: unhealthy, heartbeat /fail, alerts kept in the outbox (assessment R3-5)", async () => {
  const { c } = setup({ WATCH_HEARTBEAT_URL: BEAT, WATCH_NOTIFY_MIN: "INFO" });
  const h = harness();
  const out: string[] = [];
  const r = await runPoll(c, h.f, (s) => out.push(s));
  assert.equal(r.healthy, false);
  assert.deepEqual(h.beats, ["fail"]);
  assert.deepEqual(h.posts, []);
  assert.deepEqual(r.state.outbox.map((a) => a.rule), ["baseline"]); // retried once a channel exists
  assert.match(out.join("\n"), /no alert channel configured/);
  // --test-alert reports failure too
  assert.equal(await sendTestAlert(c, h.f, quiet), false);
});

test("--test-alert: one INFO message through each configured channel plus a heartbeat", async () => {
  const { c } = setup({ SLACK_WEBHOOK_URL: SLACK, WATCH_WEBHOOK_URL: HOOK, WATCH_HEARTBEAT_URL: BEAT });
  const h = harness();
  assert.equal(await sendTestAlert(c, h.f, quiet), true);
  assert.deepEqual(h.posts.map((p) => p.url), [SLACK, HOOK]);
  assert.match(h.posts[0].body.text, /^\[INFO\].*\n.*test-alert/);
  assert.equal(h.posts[1].body.alerts[0].rule, "test-alert");
  assert.deepEqual(h.beats, ["ok"]);
});
