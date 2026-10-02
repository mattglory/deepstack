// Unit tests for the nonce-gap/pending-tx decision (external review, issue #7 — "nonce
// handling ... untested"). nonceSafetyFromResponse is the pure interpretation of Hiro's
// /nonces response; checkNonceSafety itself (the network call around it) is exercised live,
// not here — see rpc.test.ts for the withRpc failover/timeout it relies on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nonceSafetyFromResponse } from "./nonce-safety.js";

test("nonceSafetyFromResponse: no missing nonces, nothing pending → safe", () => {
  assert.deepEqual(nonceSafetyFromResponse({}), { safe: true, missingNonces: [], mempoolPending: 0 });
});

test("nonceSafetyFromResponse: a detected gap is unsafe, regardless of mempool state", () => {
  const r = nonceSafetyFromResponse({ detected_missing_nonces: [5, 7] });
  assert.equal(r.safe, false);
  assert.deepEqual(r.missingNonces, [5, 7]);
  assert.match(r.reason!, /nonce gap detected \(missing \[5,7\]\)/);
});

test("nonceSafetyFromResponse: a gap takes priority over pending mempool nonces in the reason", () => {
  const r = nonceSafetyFromResponse({ detected_missing_nonces: [3], detected_mempool_nonces: [9] });
  assert.equal(r.safe, false);
  assert.match(r.reason!, /nonce gap detected/);
  assert.equal(r.mempoolPending, 1); // still reported, just not the reason text
});

test("nonceSafetyFromResponse: no gap but a pending mempool tx → unsafe, singular wording", () => {
  const r = nonceSafetyFromResponse({ detected_mempool_nonces: [12] });
  assert.equal(r.safe, false);
  assert.equal(r.mempoolPending, 1);
  assert.match(r.reason!, /\(1 nonce\)/);
});

test("nonceSafetyFromResponse: multiple pending mempool txs → unsafe, plural wording", () => {
  const r = nonceSafetyFromResponse({ detected_mempool_nonces: [12, 13] });
  assert.equal(r.mempoolPending, 2);
  assert.match(r.reason!, /\(2 nonces\)/);
});
