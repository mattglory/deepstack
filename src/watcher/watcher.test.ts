// Classification and per-poll evaluation for the wallet watcher. Offline: real mainnet txs
// from fixtures/ (public on-chain data, trimmed) plus small synthetic txs for edge cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTxWithTransfers, parseBalances } from "./sources.js";
import { classifyTx, evaluatePoll, emptyState, isAllowedRecipient, type Observation, type WatchedTx } from "./watcher.js";
import { buildRules, loadConfig } from "./run.js";
import { MAINNET_ALLOWLIST, AGENT_WALLET } from "./allowlist.js";

const A = AGENT_WALLET;
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const FIXTURE_TXS: WatchedTx[] = fx("mainnet-transactions.json").results.map(parseTxWithTransfers);
const byPrefix = (p: string) => FIXTURE_TXS.find((t) => t.txid.startsWith(p))!;
const rules = (env: Record<string, string> = {}) => buildRules(loadConfig(env));
const rulesOf = (tx: WatchedTx, r = rules()) => classifyTx(tx, A, r).map((f) => `${f.severity}:${f.rule}`).sort();

const XYK_CORE = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2";
const XYK_POOL = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1";
const ATTACKER = "SP3ATTACKERXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token";

function tx(over: Partial<WatchedTx>): WatchedTx {
  return {
    txid: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0"),
    pending: false,
    status: "success",
    type: "contract_call",
    sender: A,
    sponsored: false,
    nonce: 1,
    fee: 50_000n,
    blockHeight: 100,
    time: "2026-11-01T00:00:00.000Z",
    contractId: XYK_CORE,
    functionName: "swap-y-for-x",
    transfers: [],
    ...over,
  };
}

function obs(over: Partial<Observation> = {}): Observation {
  return { address: A, tipHeight: 100, balances: { STX: 1_000_000_000n }, confirmed: [], mempool: [], missingNonces: [], historyTotal: 0, ...over };
}

// --- fixture classification: one assertion per real tx shape ---

test("fixtures: the agent's routine calls are INFO allowlisted-call", () => {
  for (const p of ["0x60a90885", "0xc21c79c8", "0x235e157e", "0x093e7748", "0x55b4e158", "0x10dfcfe1"]) {
    assert.deepEqual(rulesOf(byPrefix(p)), ["INFO:allowlisted-call"], p);
  }
});

test("fixtures: incoming STX (including lookalike-address dust) is INFO incoming", () => {
  assert.deepEqual(rulesOf(byPrefix("0xe24f3841")), ["INFO:incoming"]);
  assert.deepEqual(rulesOf(byPrefix("0xc31068da")), ["INFO:incoming"]);
});

test("fixtures: STX transfer to an address not on OWNER_ALLOWLIST is CRITICAL", () => {
  assert.deepEqual(rulesOf(byPrefix("0xe1e976b1")), ["CRITICAL:stx-transfer-unlisted"]);
  // ...and INFO once the owner lists that destination.
  const owner = byPrefix("0xe1e976b1").stxRecipient!;
  assert.deepEqual(rulesOf(byPrefix("0xe1e976b1"), rules({ OWNER_ALLOWLIST: owner })), ["INFO:owner-transfer"]);
});

test("fixtures: call to a contract the agent never calls is CRITICAL, with its fund flow", () => {
  assert.deepEqual(rulesOf(byPrefix("0xf5c85b5e")), ["CRITICAL:transfer-unlisted", "CRITICAL:unlisted-contract"]);
  assert.deepEqual(rulesOf(byPrefix("0x9a1b1c05")), ["CRITICAL:unlisted-contract"]); // vault v1: operator-only
});

test("fixtures: contract deploy from the wallet is CRITICAL", () => {
  assert.deepEqual(rulesOf(byPrefix("0xf39eba1b")), ["CRITICAL:deploy"]);
});

test("fixtures: aborted txs are HIGH failed (and still CRITICAL if the target is unlisted)", () => {
  assert.deepEqual(rulesOf(byPrefix("0x5640b17b")), ["HIGH:failed", "INFO:allowlisted-call"]);
  assert.deepEqual(rulesOf(byPrefix("0x9725adb7")), ["CRITICAL:unlisted-contract", "HIGH:failed"]);
});

// --- allowlist logic ---

test("allowlist: every entry documents its source, ids are unique principals", () => {
  const ids = MAINNET_ALLOWLIST.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of MAINNET_ALLOWLIST) {
    assert.match(e.id, /^S[PM][0-9A-Z]+(\.[a-z0-9-]+)?$/);
    assert.ok(e.source.length > 0, e.id);
  }
});

test("allowlist: burn, self, owners and counterparties are acceptable recipients; strangers are not", () => {
  const r = rules({ OWNER_ALLOWLIST: "SP1OWNER" });
  for (const ok of ["", A, "SP1OWNER", XYK_POOL, "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10"]) assert.ok(isAllowedRecipient(r, ok), ok);
  assert.ok(!isAllowedRecipient(r, ATTACKER));
  // A counterparty is not a call target: calling a pool directly is CRITICAL.
  assert.deepEqual(rulesOf(tx({ contractId: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10" }), r), ["CRITICAL:unlisted-contract"]);
});

test("allowlist: WATCH_CONTRACT_ALLOWLIST extends call targets", () => {
  const extra = "SP3B8F1ERXWHQ7FSZB6RSJA1S12DBQZZNYYHTPBFF.agg-d-v-1-sh-0";
  assert.deepEqual(rulesOf(byPrefix("0xf5c85b5e"), rules({ WATCH_CONTRACT_ALLOWLIST: extra })), ["INFO:allowlisted-call"]);
});

test("classify: allowlisted call that moves funds to a stranger is still CRITICAL", () => {
  const t = tx({ transfers: [{ kind: "ft", asset: SBTC, amount: 5n, sender: A, recipient: ATTACKER }] });
  assert.deepEqual(rulesOf(t), ["CRITICAL:transfer-unlisted", "INFO:allowlisted-call"]);
});

test("classify: NFT out to a stranger is CRITICAL", () => {
  const t = tx({ transfers: [{ kind: "nft", asset: "SM1.x::pool-token-id", amount: 1n, sender: A, recipient: ATTACKER }] });
  assert.ok(rulesOf(t).includes("CRITICAL:transfer-unlisted"));
});

test("classify: large movement via an allowlisted contract is HIGH", () => {
  const t = tx({ transfers: [{ kind: "stx", asset: "STX", amount: 600_000_000n, sender: A, recipient: XYK_POOL }] });
  assert.deepEqual(classifyTx(t, A, rules(), { STX: 1_000_000_000n }).map((f) => f.rule).sort(), ["allowlisted-call", "large-movement"]);
  assert.deepEqual(classifyTx(t, A, rules({ WATCH_LARGE_MOVE_PCT: "70" }), { STX: 1_000_000_000n }).map((f) => f.rule), ["allowlisted-call"]);
});

// --- evaluatePoll: baseline, dedup, mempool→confirmed, balance drop ---

test("first run baselines history: one INFO summary, no per-tx alerts, counts what it skipped", () => {
  const res = evaluatePoll(emptyState("mainnet"), [obs({ tipHeight: 9_400_000, confirmed: FIXTURE_TXS, historyTotal: 303 })], rules());
  assert.deepEqual(res.alerts.map((a) => a.rule), ["baseline"]);
  assert.deepEqual(res.baselined[0].wouldBe, { CRITICAL: 7, HIGH: 3, INFO: 9 });
  assert.equal(res.state.addresses[A].seen.length, FIXTURE_TXS.length);
});

test("first run still alerts on what is pending in the mempool right now", () => {
  const pending = tx({ pending: true, status: "pending", type: "token_transfer", contractId: undefined, stxRecipient: ATTACKER, stxAmount: 5n, blockHeight: undefined });
  const res = evaluatePoll(emptyState("mainnet"), [obs({ mempool: [pending] })], rules());
  assert.deepEqual(res.alerts.map((a) => `${a.severity}:${a.rule}`).sort(), ["CRITICAL:stx-transfer-unlisted", "INFO:baseline"]);
});

test("dedup: the same tx+rule never alerts twice across polls", () => {
  let s = evaluatePoll(emptyState("mainnet"), [obs()], rules()).state;
  const bad = tx({ blockHeight: 101, contractId: "SP3EVIL.drain" });
  const o = obs({ tipHeight: 101, confirmed: [bad], balances: { STX: 1_000_000_000n - 50_000n } });
  const first = evaluatePoll(s, [o], rules());
  assert.deepEqual(first.alerts.map((a) => a.rule), ["unlisted-contract"]);
  s = first.state;
  assert.deepEqual(evaluatePoll(s, [{ ...o, tipHeight: 102 }], rules()).alerts, []);
});

test("mempool → confirmed: alerts once while pending, only NEW rules fire on confirmation", () => {
  let s = evaluatePoll(emptyState("mainnet"), [obs()], rules()).state;
  const id = "0x" + "ab".repeat(32);
  const pending = tx({ txid: id, pending: true, status: "pending", blockHeight: undefined, contractId: "SP3EVIL.drain" });
  const r1 = evaluatePoll(s, [obs({ tipHeight: 100, mempool: [pending] })], rules());
  assert.deepEqual(r1.alerts.map((a) => a.rule), ["unlisted-contract"]);
  s = r1.state;
  // Confirms, moving sBTC to the attacker: unlisted-contract is NOT repeated; the transfer is new.
  const confirmed = tx({ txid: id, blockHeight: 101, contractId: "SP3EVIL.drain", transfers: [{ kind: "ft", asset: SBTC, amount: 10n, sender: A, recipient: ATTACKER }] });
  const r2 = evaluatePoll(s, [obs({ tipHeight: 101, confirmed: [confirmed], balances: { STX: 1_000_000_000n - 50_000n } })], rules());
  assert.deepEqual(r2.alerts.map((a) => a.rule), ["transfer-unlisted"]);
  // A pending tx that later FAILS raises the failed rule.
  const r3 = evaluatePoll(r2.state, [obs({ tipHeight: 102, confirmed: [{ ...confirmed, txid: "0x" + "cd".repeat(32), blockHeight: 102, status: "abort_by_response", transfers: [] }] })], rules());
  assert.ok(r3.alerts.some((a) => a.rule === "failed"));
});

test("confirmed txs above the balance read height wait for the next poll", () => {
  const s = evaluatePoll(emptyState("mainnet"), [obs()], rules()).state;
  const later = tx({ blockHeight: 105, contractId: "SP3EVIL.drain" });
  const r = evaluatePoll(s, [obs({ tipHeight: 104, confirmed: [later] })], rules());
  assert.deepEqual(r.alerts, []);
  assert.ok(!r.state.addresses[A].seen.includes(later.txid));
});

test("balance drop explained by allowlisted activity is not an alert", () => {
  const s = evaluatePoll(emptyState("mainnet"), [obs()], rules()).state;
  const swap = tx({ blockHeight: 101, transfers: [{ kind: "stx", asset: "STX", amount: 50_000_000n, sender: A, recipient: XYK_POOL }] });
  const r = evaluatePoll(s, [obs({ tipHeight: 101, confirmed: [swap], balances: { STX: 1_000_000_000n - 50_000_000n - 50_000n } })], rules());
  assert.deepEqual(r.alerts.map((a) => a.rule), ["allowlisted-call"]);
});

test("balance drop NOT explained by visible allowlisted activity is CRITICAL", () => {
  const s = evaluatePoll(emptyState("mainnet"), [obs({ balances: { STX: 1_000_000_000n, [SBTC]: 1000n } })], rules()).state;
  const r = evaluatePoll(s, [obs({ tipHeight: 101, balances: { STX: 1_000_000_000n, [SBTC]: 100n } })], rules());
  assert.deepEqual(r.alerts.map((a) => `${a.severity}:${a.rule}`), ["CRITICAL:balance-drop"]);
  // A small drop under the threshold (here 10%) is not.
  const small = evaluatePoll(s, [obs({ tipHeight: 101, balances: { STX: 950_000_000n, [SBTC]: 1000n } })], rules());
  assert.deepEqual(small.alerts, []);
});

test("nonce gap and failure burst are HIGH", () => {
  const s = evaluatePoll(emptyState("mainnet"), [obs()], rules()).state;
  const fails = [1, 2, 3].map((n) => tx({ nonce: n, blockHeight: 101, status: "abort_by_response" }));
  const r = evaluatePoll(s, [obs({ tipHeight: 101, confirmed: fails, missingNonces: [7], balances: { STX: 1_000_000_000n - 150_000n } })], rules());
  const rs = r.alerts.map((a) => a.rule);
  assert.equal(rs.filter((x) => x === "failed").length, 3);
  assert.ok(rs.includes("failed-burst"));
  assert.ok(rs.includes("nonce-gap"));
  assert.ok(r.alerts.filter((a) => a.rule !== "allowlisted-call").every((a) => a.severity === "HIGH"));
});

test("corrupt-state recovery window: recent txs alert, older ones are baselined", () => {
  const recent = tx({ blockHeight: 99, time: "2026-11-02T12:00:00.000Z", contractId: "SP3EVIL.drain" });
  const old = tx({ blockHeight: 50, time: "2026-10-01T00:00:00.000Z", contractId: "SP3EVIL.old" });
  const r = evaluatePoll(emptyState("mainnet"), [obs({ confirmed: [recent, old] })], rules(), { recoverSince: Date.parse("2026-11-02T00:00:00.000Z") });
  assert.deepEqual(r.alerts.map((a) => `${a.rule}:${a.txid ?? ""}`).sort(), ["baseline:", `unlisted-contract:${recent.txid}`]);
});

test("parseBalances reads the real balances fixture", () => {
  const b = parseBalances(fx("mainnet-balances.json"));
  assert.equal(b.STX, 49_966_468n);
  assert.equal(b["SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx::usdcx-token"], 64_026_003n);
});
