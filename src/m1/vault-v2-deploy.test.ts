// Offline tests for the vault v2 deploy safety logic (roadmap C10). Every network read, git
// call and broadcast is a fake; nothing here touches a node or a key that holds funds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Cl, PostConditionMode, randomPrivateKey, getAddressFromPrivateKey, createAddress,
  addressFromVersionHash, addressToString, type ClarityValue,
} from "@stacks/transactions";
import {
  AGENT_HOT_WALLET, HOT_ADMIN_OVERRIDE, NETWORK_ID, TOKEN, VAULT, MAINNET_TRAIT,
  networkFromFlags, assertNodeNetwork, assertTxChain, assertFeeCap, validatePrincipals, isMultisig,
  gitState, sourcesAt, buildPlan, planSha, checkProceed, buildDeployTxs, broadcastAll,
  verifyDeployment, deploymentRecord, recordPath, postConditionsFor, sha256, type Network, type Principals,
} from "./vault-v2-deploy.js";

const addr = (n: Network) => getAddressFromPrivateKey(randomPrivateKey(), n);
const multisigOf = (a: string, n: Network) =>
  addressToString(addressFromVersionHash(n === "mainnet" ? 20 : 21, createAddress(a).hash160));
const COMMIT = "a".repeat(40);
const fakeGit = (dirty = "") => (args: string[]) => {
  if (args[0] === "rev-parse") return COMMIT + "\n";
  if (args[0] === "status") return dirty;
  if (args[0] === "show") return readFileSync(args[1].split(":")[1], "utf8");
  throw new Error("unexpected git " + args.join(" "));
};
const roles = (n: Network): Principals => ({
  admin: multisigOf(addr(n), n), strategy: addr(n), guardian: addr(n), feeRecipient: addr(n),
});

// ---- network -------------------------------------------------------------------------------

test("network: exactly one explicit flag, matching the resolved network", () => {
  assert.throws(() => networkFromFlags(new Set(), "testnet"), /exactly one of --testnet or --mainnet/);
  assert.throws(() => networkFromFlags(new Set(["--testnet", "--mainnet"]), "testnet"), /exactly one/);
  assert.throws(() => networkFromFlags(new Set(["--testnet"]), "mainnet"), /resolves to mainnet/);
  assert.throws(() => networkFromFlags(new Set(["--mainnet"]), "testnet"), /resolves to testnet/);
  assert.equal(networkFromFlags(new Set(["--testnet"]), "testnet"), "testnet");
  assert.equal(networkFromFlags(new Set(["--mainnet"]), "mainnet"), "mainnet");
});

test("network: a node on the other chain is refused before any broadcast", async () => {
  const node = (id: number) => async (path: string) => { assert.equal(path, "/v2/info"); return { network_id: id }; };
  await assert.rejects(assertNodeNetwork("testnet", node(1)), /node network_id 1 is not testnet/);
  await assert.rejects(assertNodeNetwork("mainnet", node(0x80000000)), /is not mainnet/);
  await assertNodeNetwork("testnet", node(2147483648));
  await assertNodeNetwork("mainnet", node(1));
});

test("multisig sign: chain id must match the configured network, and the fee is capped", () => {
  assert.throws(() => assertTxChain(NETWORK_ID.testnet, "mainnet"), /chain id 2147483648 is not mainnet/);
  assert.throws(() => assertTxChain(NETWORK_ID.mainnet, "testnet"), /is not testnet/);
  assertTxChain(NETWORK_ID.mainnet, "mainnet");
  assert.throws(() => assertFeeCap(500_001n), /above the cap/);
  assertFeeCap(100_000n);
});

// ---- principals ------------------------------------------------------------------------------

test("principals: no defaults, every role must be given", () => {
  const deployer = addr("testnet");
  const r = roles("testnet");
  for (const k of ["admin", "strategy", "guardian", "feeRecipient"] as const) {
    assert.throws(() => validatePrincipals({ ...r, [k]: undefined }, { network: "testnet", deployer }), new RegExp(`${k} must be given explicitly`));
  }
});

test("principals: deployer and merged roles are refused, as the contract does", () => {
  const deployer = addr("testnet");
  const r = roles("testnet");
  const ctx = { network: "testnet" as const, deployer };
  assert.throws(() => validatePrincipals({ ...r, admin: deployer }, ctx), /admin is the deployer/);
  assert.throws(() => validatePrincipals({ ...r, strategy: deployer }, ctx), /strategy is the deployer/);
  assert.throws(() => validatePrincipals({ ...r, strategy: r.admin }, ctx), /admin and strategy/);
  assert.throws(() => validatePrincipals({ ...r, guardian: r.admin }, ctx), /admin and guardian/);
  assert.throws(() => validatePrincipals({ ...r, guardian: r.strategy }, ctx), /strategy and guardian/);
  assert.throws(() => validatePrincipals({ ...r, strategy: addr("mainnet") }, ctx), /not a testnet principal/);
  assert.deepEqual(validatePrincipals({ ...r, guardian: deployer, feeRecipient: deployer }, ctx), { ...r, guardian: deployer, feeRecipient: deployer });
});

test("principals: the agent hot wallet as admin is refused; testnet only with the loud override", () => {
  assert.equal(createAddress(AGENT_HOT_WALLET.testnet).hash160, createAddress(AGENT_HOT_WALLET.mainnet).hash160); // same key
  const deployer = addr("testnet");
  const r = { ...roles("testnet"), admin: AGENT_HOT_WALLET.testnet };
  assert.throws(() => validatePrincipals(r, { network: "testnet", deployer }), new RegExp(`agent hot wallet.*${HOT_ADMIN_OVERRIDE}`));
  assert.equal(validatePrincipals(r, { network: "testnet", deployer, allowHotAdmin: true }).admin, AGENT_HOT_WALLET.testnet);
  const m = { ...roles("mainnet"), admin: AGENT_HOT_WALLET.mainnet };
  assert.throws(() => validatePrincipals(m, { network: "mainnet", deployer: addr("mainnet"), allowHotAdmin: true }), /agent hot wallet/);
});

test("principals: on mainnet the admin must be a native multisig (SM...)", () => {
  const deployer = addr("mainnet");
  const r = roles("mainnet");
  assert.ok(r.admin.startsWith("SM") && isMultisig(r.admin, "mainnet"));
  assert.throws(() => validatePrincipals({ ...r, admin: addr("mainnet") }, { network: "mainnet", deployer }), /native multisig \(SM\.\.\.\)/);
  assert.equal(validatePrincipals(r, { network: "mainnet", deployer }).admin, r.admin);
});

// ---- plan and proceed gate -------------------------------------------------------------------

const planFor = (network: Network, dirty = "") => {
  const key = randomPrivateKey();
  const deployer = getAddressFromPrivateKey(key, network);
  const g = gitState(fakeGit(dirty));
  const sources = sourcesAt(network, g.commit, fakeGit(dirty));
  const principals = validatePrincipals(roles(network), { network, deployer });
  const plan = buildPlan({ network, deployer, git: g, sources, principals, startNonce: 7n });
  return { key, deployer, g, sources, plan };
};

test("sources come from the pinned commit; only the testnet token is substituted", () => {
  const t = sourcesAt("testnet", COMMIT, fakeGit());
  assert.deepEqual(t.map((s) => s.name), ["sip-010-trait-ft-standard-v-1-1", TOKEN, VAULT]);
  const tok = t.find((s) => s.name === TOKEN)!;
  assert.ok(tok.substituted && !tok.code.includes(MAINNET_TRAIT) && tok.repoSha256 !== tok.deployedSha256);
  const m = sourcesAt("mainnet", COMMIT, fakeGit());
  assert.deepEqual(m.map((s) => s.name), [TOKEN, VAULT]);
  for (const s of m) assert.equal(s.repoSha256, s.deployedSha256);
  assert.equal(m[1].repoSha256, sha256(readFileSync("contracts/deepstack-vault-v2.clar", "utf8")));
});

test("plan: consecutive nonces for deploy, link and initialize; reviewable fields", () => {
  const { plan, deployer } = planFor("testnet");
  assert.deepEqual(plan.transactions.map((t) => t.nonce), ["7", "8", "9", "10", "11"]);
  assert.deepEqual(plan.transactions.slice(3).map((t) => t.function), ["set-vault-contract", "initialize"]);
  assert.equal(plan.deployer, deployer);
  assert.equal(plan.git.commit, COMMIT);
  assert.equal(plan.contracts.length, 3);
  assert.match(planSha(plan), /^[0-9a-f]{64}$/);
});

test("proceed: a dirty tree is refused", () => {
  const { plan, g } = planFor("testnet", " M contracts/deepstack-vault-v2.clar\n");
  assert.equal(g.clean, false);
  assert.throws(() => checkProceed(plan, g, { commit: COMMIT }), /working tree is dirty/);
});

test("proceed: the commit must be pinned and equal HEAD", () => {
  const { plan, g } = planFor("testnet");
  assert.throws(() => checkProceed(plan, g, {}), /pin the commit with --commit=/);
  assert.throws(() => checkProceed(plan, g, { commit: "b".repeat(40) }), /is not HEAD/);
  checkProceed(plan, g, { commit: COMMIT });
});

test("proceed: mainnet needs --yes-mainnet and the exact plan sha", () => {
  const { plan, g } = planFor("mainnet");
  assert.throws(() => checkProceed(plan, g, { commit: COMMIT, planSha: planSha(plan) }), /--yes-mainnet/);
  assert.throws(() => checkProceed(plan, g, { commit: COMMIT, yesMainnet: true }), /--plan-sha does not match/);
  assert.throws(() => checkProceed(plan, g, { commit: COMMIT, yesMainnet: true, planSha: "0".repeat(64) }), /--plan-sha does not match/);
  const other = { ...plan, transactions: plan.transactions.map((t, i) => (i === 0 ? { ...t, nonce: "99" } : t)) };
  assert.throws(() => checkProceed(other, g, { commit: COMMIT, yesMainnet: true, planSha: planSha(plan) }), /--plan-sha does not match/);
  checkProceed(plan, g, { commit: COMMIT, yesMainnet: true, planSha: planSha(plan) });
});

// ---- happy path, verify ----------------------------------------------------------------------

const chainFor = (plan: ReturnType<typeof planFor>["plan"], sources: ReturnType<typeof planFor>["sources"], tamper?: string) => ({
  fetchJson: async (path: string) => {
    const name = path.split("/")[5].split("?")[0];
    const code = sources.find((s) => s.name === name)!.code;
    return { source: name === tamper ? code + "\n;; changed" : code, publish_height: 1 };
  },
  callRead: async (contract: string, fn: string): Promise<ClarityValue> => {
    if (contract === VAULT && fn === "get-state") {
      return Cl.tuple({
        initialized: Cl.bool(true), admin: Cl.principal(plan.principals.admin), strategy: Cl.principal(plan.principals.strategy),
        guardian: Cl.principal(plan.principals.guardian), "fee-recipient": Cl.principal(plan.principals.feeRecipient),
      });
    }
    if (contract === TOKEN && fn === "get-vault-contract") return Cl.ok(Cl.some(Cl.contractPrincipal(plan.deployer, VAULT)));
    throw new Error("unexpected read " + contract + " " + fn);
  },
});

test("happy path: plan, offline-signed txs on consecutive nonces, broadcast, verify, record", async () => {
  const { plan, sources, key, g } = planFor("testnet");
  checkProceed(plan, g, { commit: COMMIT });
  const txs = await buildDeployTxs(plan, sources, key);
  assert.deepEqual(txs.map((t) => t.label), ["deploy sip-010-trait-ft-standard-v-1-1", `deploy ${TOKEN}`, `deploy ${VAULT}`, "set-vault-contract", "initialize"]);
  assert.deepEqual(txs.map((t) => t.tx.auth.spendingCondition.nonce), [7n, 8n, 9n, 10n, 11n]);
  for (const t of txs) {
    assert.equal(t.tx.chainId, NETWORK_ID.testnet);
    assert.equal(t.tx.postConditionMode, PostConditionMode.Deny);
  }
  let i = 0;
  const sent: string[] = [];
  const txids = await broadcastAll(txs, async (tx) => { sent.push(tx.txid()); return { txid: `0x${++i}` }; });
  assert.equal(sent.length, 5);
  assert.deepEqual(txids.map((t) => t.txid), ["0x1", "0x2", "0x3", "0x4", "0x5"]);
  const c = chainFor(plan, sources);
  const v = await verifyDeployment(plan, c.fetchJson, c.callRead);
  assert.equal(v.ok, true, JSON.stringify(v.checks));
  const rec = deploymentRecord(plan, txids, v, new Date("2026-11-03T12:00:00Z"));
  assert.equal(rec.planSha256, planSha(plan));
  assert.equal(recordPath("testnet", new Date("2026-11-03T12:00:00Z")), "deployments/v2-testnet-2026-11-03.json");
  assert.deepEqual(JSON.parse(JSON.stringify(rec)).txids, txids);
});

test("broadcast stops at the first rejection and reports what went out", async () => {
  const { plan, sources, key } = planFor("testnet");
  const txs = await buildDeployTxs(plan, sources, key);
  let n = 0;
  await assert.rejects(
    broadcastAll(txs, async () => (++n === 2 ? { error: "rejected", reason: "BadNonce" } : { txid: `0x${n}` })),
    (e: any) => /deploy deepstack-vault-v2-token rejected/.test(e.message) && e.done.length === 1,
  );
  assert.equal(n, 2);
});

test("a deploy tx is refused if its source no longer matches the plan", async () => {
  const { plan, sources, key } = planFor("testnet");
  const bad = sources.map((s) => (s.name === VAULT ? { ...s, code: s.code + " " } : s));
  await assert.rejects(buildDeployTxs(plan, bad, key), /source for deepstack-vault-v2 does not match the plan/);
});

test("verify detects a source mismatch and a wrong role", async () => {
  const { plan, sources } = planFor("testnet");
  const c = chainFor(plan, sources, VAULT);
  const v = await verifyDeployment(plan, c.fetchJson, c.callRead);
  assert.equal(v.ok, false);
  assert.deepEqual(v.checks.filter((x) => !x.ok).map((x) => x.name), [`source ${VAULT}`]);
  const wrongAdmin = { ...plan, principals: { ...plan.principals, admin: multisigOf(addr("testnet"), "testnet") } };
  const v2 = await verifyDeployment(wrongAdmin, chainFor(plan, sources).fetchJson, chainFor(plan, sources).callRead);
  assert.deepEqual(v2.checks.filter((x) => !x.ok).map((x) => x.name), ["vault admin"]);
});

// ---- post-conditions -------------------------------------------------------------------------

test("post-conditions: exact amounts in deny mode for deposit, sweep, return, recover", () => {
  const ctx = { vaultId: `${addr("testnet")}.${VAULT}`, sender: addr("testnet") };
  for (const fn of ["deposit", "sweep", "return-from-strategy", "recover-from-strategy"]) {
    const pc = postConditionsFor(fn, 5_000_000n, ctx)!;
    assert.equal(pc.mode, PostConditionMode.Deny);
    assert.equal(pc.postConditions.length, 1);
    assert.equal((pc.postConditions[0] as any).amount, "5000000");
    assert.equal((pc.postConditions[0] as any).condition, "eq");
    assert.equal((pc.postConditions[0] as any).address, fn === "sweep" ? ctx.vaultId : ctx.sender);
  }
  assert.deepEqual(postConditionsFor("return-from-strategy", 0n, ctx)!.postConditions, []); // a return of 0 moves nothing
  for (const fn of ["settle-overdue", "pause-deposits", "queue-fee-bps", "confirm-guardian", "accept-strategy-change", "initialize"]) {
    assert.deepEqual(postConditionsFor(fn, null, ctx), { mode: PostConditionMode.Deny, postConditions: [] });
  }
  for (const fn of ["claim-withdrawal", "claim-deposit", "cancel-deposit", "request-withdrawal"]) assert.equal(postConditionsFor(fn, null, ctx), null);
});
