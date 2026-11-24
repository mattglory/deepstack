// Hiro source failover and response parsing — offline, with a mock fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fx, fixtureFetch } from "./fixtures/mock-fetch.js";
import { HiroSource, chainTip, observeAddress, parseTx } from "./sources.js";
import { AGENT_WALLET } from "./allowlist.js";

const TIP: number = fx("mainnet-status.json").chain_tip.block_height;
const P = "https://primary.example";
const B = "https://backup.example";

test("source: primary erroring fails over to the backup, then sticks to it", async () => {
  const { f, calls } = fixtureFetch({ bad: { [P]: "error" } });
  const src = new HiroSource([P, B], 1000, f, () => {});
  assert.equal(await chainTip(src), TIP);
  assert.equal(await chainTip(src), TIP);
  assert.deepEqual(calls.map((c) => new URL(c).origin), [P, B, B]);
});

test("source: a HANGING primary times out and fails over", async () => {
  const { f } = fixtureFetch({ bad: { [P]: "hang" } });
  const src = new HiroSource([P, B], 30, f, () => {});
  const t0 = Date.now();
  assert.equal(await chainTip(src), TIP);
  assert.ok(Date.now() - t0 < 2000);
});

test("source: HTTP 5xx counts as a failure; all endpoints down throws", async () => {
  const { f } = fixtureFetch({ bad: { [P]: "500", [B]: "error" } });
  const src = new HiroSource([P, B], 100, f, () => {});
  await assert.rejects(chainTip(src), /backup\.example.*ECONNREFUSED/);
});

test("observeAddress: parses balances, txs, nonces from real response shapes", async () => {
  const { f, calls } = fixtureFetch();
  const src = new HiroSource([P], 1000, f, () => {});
  const o = await observeAddress(src, AGENT_WALLET, TIP);
  assert.equal(o.balances.STX, 49_966_468n);
  assert.equal(o.confirmed.length, 15);
  assert.deepEqual(o.missingNonces, []);
  assert.ok(calls.some((c) => c.includes(`balances?until_block=${TIP}`)), "balances read at the tip height");
  const add = o.confirmed.find((t) => t.functionName === "add-liquidity")!;
  assert.equal(add.fee, 50_000n);
  assert.ok(add.transfers.some((t) => t.kind === "stx" && t.sender === AGENT_WALLET));
  assert.equal(calls.length, 4); // first run: a single tx page
});

test("parseTx: real mempool entries parse as pending with no block height", () => {
  const m = fx("mainnet-mempool-sample.json").results.map((t: any) => parseTx(t));
  assert.ok(m.length > 0);
  for (const t of m) {
    assert.equal(t.pending, true);
    assert.equal(t.blockHeight, undefined);
  }
  assert.ok(m.some((t: any) => t.type === "token_transfer" && typeof t.stxAmount === "bigint"));
});
