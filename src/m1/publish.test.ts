// Unit tests for the telemetry publisher — the pilot-evidence path.
//
// Two properties matter: unconfigured means untouched (no surprise network calls from a
// box that should make none), and a failing GitHub must never propagate into the cycle.
//
// METRICS_PATH is captured when metrics.ts loads, so it is pointed at a temp file BEFORE
// the dynamic import below — otherwise the suite would clobber the real dashboard/metrics.json.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.METRICS_PATH = join(tmpdir(), `deepstack-publish-test-${process.pid}.json`);
const { publishMetrics } = await import("./publish.js");
const { METRICS_PATH } = await import("./metrics.js");

beforeEach(() => {
  delete process.env.METRICS_GIST_ID;
  delete process.env.METRICS_GIST_TOKEN;
});

const ok = { ok: true, status: 200 } as Response;

test("publish: no-op unless BOTH gist id and token are configured", async () => {
  let calls = 0;
  const spy = (async () => { calls++; return ok; }) as typeof fetch;
  assert.equal(await publishMetrics(spy), false);
  process.env.METRICS_GIST_ID = "abc123";
  assert.equal(await publishMetrics(spy), false); // id without token — still off
  assert.equal(calls, 0);
});

test("publish: PATCHes the gist with the metrics file content", async () => {
  process.env.METRICS_GIST_ID = "abc123";
  process.env.METRICS_GIST_TOKEN = "ghp_test";
  writeFileSync(METRICS_PATH, `{"pair":"sbtc-stx"}`);

  let url = "", init: RequestInit = {};
  const spy = (async (u: any, i: any) => { url = String(u); init = i; return ok; }) as typeof fetch;
  assert.equal(await publishMetrics(spy), true);

  assert.equal(url, "https://api.github.com/gists/abc123");
  assert.equal(init.method, "PATCH");
  assert.match((init.headers as Record<string, string>).Authorization, /^Bearer ghp_test$/);
  const body = JSON.parse(init.body as string);
  assert.equal(body.files["metrics.json"].content, `{"pair":"sbtc-stx"}`);
});

test("publish: a throwing fetch does not propagate — the cycle survives", async () => {
  process.env.METRICS_GIST_ID = "abc123";
  process.env.METRICS_GIST_TOKEN = "ghp_test";
  const boom = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as typeof fetch;
  assert.equal(await publishMetrics(boom), false); // must not reject
});

test("publish: a non-2xx response is a failure, not a success", async () => {
  process.env.METRICS_GIST_ID = "abc123";
  process.env.METRICS_GIST_TOKEN = "bad-token";
  const denied = (async () => ({ ok: false, status: 401 }) as Response) as typeof fetch;
  assert.equal(await publishMetrics(denied), false);
});
