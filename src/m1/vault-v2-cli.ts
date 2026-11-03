// Vault v2 operations: deploy and drive contracts/deepstack-vault-v2.clar and its token.
//
// Network: every command needs exactly one of --testnet / --mainnet, and it must match the
// network the environment resolves to (STACKS_NETWORK) and the node's /v2/info network_id,
// which is checked before any broadcast. --testnet loads .env.testnet (gitignored, test keys
// only) before anything else. Any mainnet broadcast still requires --yes-mainnet.
// Strategy-only calls (return, recover, accept-strategy) sign with STRATEGY_PRIVATE_KEY;
// everything else with STACKS_PRIVATE_KEY (the deployer, or an operator key on testnet).
//
// Deploying (roadmap C10, docs/VAULT_V2_DEPLOY_RUNBOOK.md): from a clean checkout and a FRESH
// deployer key, never the agent key. All four roles are explicit; there are no defaults.
//   ROLES="--admin=SN... --strategy=ST... --guardian=ST... --fee-recipient=ST..."
//   npm run m1:vault-v2 -- plan --testnet $ROLES                    # prints the plan and its sha256
//   npm run m1:vault-v2 -- deploy --testnet $ROLES --commit=<HEAD>  # trait (testnet), token, vault, link, initialize
//   npm run m1:vault-v2 -- deploy --mainnet $ROLES --commit=<HEAD> --yes-mainnet --plan-sha=<sha from plan>
//   npm run m1:vault-v2 -- verify --testnet --record=deployments/v2-testnet-<date>.json
//   npm run m1:vault-v2 -- initialize --testnet $ROLES              # only if a deploy stopped before initialize
//
//   npm run m1:vault-v2 -- status --testnet
//   npm run m1:vault-v2 -- status --testnet --env=.env.testnet-ms   # a second rehearsal deployment
//   npm run m1:vault-v2 -- deposit 100 --testnet
//   npm run m1:vault-v2 -- request <shares|all> --testnet
//   npm run m1:vault-v2 -- claim <request-id> --testnet
//   npm run m1:vault-v2 -- claim-deposit <epoch> | claim-epoch-withdrawal <epoch> --testnet
//   npm run m1:vault-v2 -- cancel-deposit | cancel-withdrawal --testnet
//   npm run m1:vault-v2 -- sweep 50 --testnet           # admin
//   npm run m1:vault-v2 -- return 55 --testnet          # strategy key
//   npm run m1:vault-v2 -- recover 10 --testnet         # strategy key, after a write-off, deposits still paused
//   npm run m1:vault-v2 -- settle-overdue --testnet     # anyone, after MAX-EPOCH
//   npm run m1:vault-v2 -- pause-deposits | pause-sweeps | unpause-deposits | unpause-sweeps --testnet
//   npm run m1:vault-v2 -- queue max-tvl|fee-bps|max-deploy-bps <n> --testnet
//   npm run m1:vault-v2 -- queue fee-recipient|strategy|guardian|admin <principal> --testnet
//   npm run m1:vault-v2 -- queue resume-sweeps --testnet
//   npm run m1:vault-v2 -- confirm max-tvl|fee-bps|max-deploy-bps|fee-recipient|guardian|resume-sweeps --testnet
//   npm run m1:vault-v2 -- accept-admin --testnet       # signed by the proposed admin
//   npm run m1:vault-v2 -- accept-strategy --testnet    # signed by the proposed strategy (STRATEGY_PRIVATE_KEY)
//   npm run m1:vault-v2 -- send-test-stx <address> <stx> --testnet   # testnet only
//
// Post-conditions (DSA-26): deposit, sweep, return and recover run in Deny mode with the exact
// STX amount; calls that move nothing run in Deny mode with none. Claims, cancels and requests
// move an amount the contract computes and stay in Allow mode (operator tooling; the deposit
// site covers those paths in deny mode, M2).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  makeContractCall, makeSTXTokenTransfer, broadcastTransaction,
  fetchCallReadOnlyFunction, fetchNonce, cvToJSON, Cl, ClarityValue, PostConditionMode,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import { loadDotenv, getWallet, apiBase, type Network } from "./wallet.js";
import { hiroHeaders } from "./rpc.js";
import {
  VAULT, TOKEN, CALL_FEE, HOT_ADMIN_OVERRIDE, networkFromFlags, assertNodeNetwork, validatePrincipals,
  gitState, sourcesAt, buildPlan, planText, planSha, checkProceed, buildDeployTxs, broadcastAll,
  verifyDeployment, recordPath, deploymentRecord, postConditionsFor, type DeployPlan,
} from "./vault-v2-deploy.js";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const pos = argv.filter((a) => !a.startsWith("--"));
// --env=<file> loads an extra env file FIRST (first value wins), e.g. a second testnet deployer
// key for a separate rehearsal deployment, without touching .env.testnet.
const envFlag = [...flags].find((f) => f.startsWith("--env="));
if (envFlag) loadDotenv(envFlag.slice("--env=".length));
if (flags.has("--testnet")) loadDotenv(".env.testnet");

const flagVal = (name: string) => [...flags].find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ustx = (stx: string) => {
  const n = Number(stx);
  if (!(n > 0)) throw new Error(`bad STX amount: ${stx}`);
  return BigInt(Math.round(n * 1e6));
};
const fmtStx = (u: bigint | number | string) => (Number(u) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtShares = (u: bigint | number | string) => (Number(u) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });

async function api(network: Network, path: string, init?: RequestInit): Promise<any> {
  const base = apiBase(network);
  const res = await fetch(base + path, { ...init, headers: { ...(init?.headers ?? {}), ...hiroHeaders(base) } });
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
  return res.json();
}

async function waitForTx(network: Network, txid: string): Promise<boolean> {
  process.stdout.write("  confirming");
  for (let i = 0; i < 60; i++) {
    await sleep(6000);
    process.stdout.write(".");
    try {
      const j = await api(network, `/extended/v1/tx/${txid}`);
      if (j.tx_status && j.tx_status !== "pending") {
        console.log(`\n  status: ${j.tx_status}${j.tx_result?.repr ? `  ${j.tx_result.repr}` : ""}`);
        return j.tx_status === "success";
      }
    } catch {
      // not indexed yet, or a transient API error: keep polling
    }
  }
  console.log("\n  status: still pending, check the explorer");
  return false;
}

async function main() {
  const cmd = pos[0];
  const w = await getWallet();
  const network = networkFromFlags(flags, w.network);
  const readOnlyCmds = ["status", "plan", "verify"];
  if (network === "mainnet" && !flags.has("--yes-mainnet") && !readOnlyCmds.includes(cmd ?? "")) {
    console.log("refusing: this would broadcast on MAINNET. Add --yes-mainnet, or use --testnet.");
    process.exit(1);
  }
  // The node must be on the chosen network before anything is planned or broadcast.
  await assertNodeNetwork(network, (p) => api(network, p));
  const strategyKey = process.env.STRATEGY_PRIVATE_KEY?.trim();
  const strategyAddr = strategyKey ? getAddressFromPrivateKey(strategyKey, network) : null;
  const vaultId = `${w.address}.${VAULT}`;
  console.log(`network: ${network} | operator: ${w.address} | vault: ${vaultId}${strategyAddr ? ` | strategy key: ${strategyAddr}` : ""}\n`);

  const ro = async (fn: string, args: ClarityValue[] = [], contract = VAULT) =>
    cvToJSON(
      await fetchCallReadOnlyFunction({
        contractAddress: w.address, contractName: contract, functionName: fn, functionArgs: args,
        network, senderAddress: w.address, client: { baseUrl: apiBase(network) },
      }),
    );

  const send = async (fn: string, args: ClarityValue[], key = w.key, amount: bigint | null = null) => {
    const sender = getAddressFromPrivateKey(key, network);
    const nonce = await fetchNonce({ address: sender, network, client: { baseUrl: apiBase(network) } });
    const pcs = postConditionsFor(fn, amount, { vaultId, sender });
    const tx = await makeContractCall({
      contractAddress: w.address, contractName: VAULT, functionName: fn, functionArgs: args,
      senderKey: key, network, fee: CALL_FEE, nonce,
      postConditionMode: pcs?.mode ?? PostConditionMode.Allow, postConditions: pcs?.postConditions ?? [],
    });
    const res = await broadcastTransaction({ transaction: tx, network });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`${fn}: txid ${res.txid}`);
    const ok = await waitForTx(network, res.txid);
    if (!ok) process.exitCode = 1;
    return ok;
  };
  const asStrategy = () => {
    if (!strategyKey) throw new Error("STRATEGY_PRIVATE_KEY is not set");
    return strategyKey;
  };

  if (cmd === "status") {
    const s = (await ro("get-state")).value;
    const v = (k: string) => s[k]?.value;
    console.log(`initialized: ${v("initialized")} | admin: ${v("admin")} | strategy: ${v("strategy")}`);
    console.log(`guardian: ${v("guardian")} | fee recipient: ${v("fee-recipient")}`);
    console.log(`max TVL ${fmtStx(v("max-tvl"))} STX | fee ${Number(v("fee-bps")) / 100}% | sweep cap ${Number(v("max-deploy-bps")) / 100}%`);
    console.log(`deposits paused: ${v("deposits-paused")} | sweeps paused: ${v("sweeps-paused")} | no change pending: ${v("no-change-pending")}`);
    console.log(`epoch ${v("current-epoch")} | open: ${v("epoch-open")} | overdue: ${v("overdue")}`);
    console.log(`vault STX ${fmtStx(v("vault-stx"))} | at strategy ${fmtStx(v("capital-at-strategy"))} | pending deposits ${fmtStx(v("pending-deposits"))} | ring-fenced ${fmtStx(v("ringfenced"))}`);
    console.log(`total assets ${fmtStx(v("total-assets"))} STX | supply ${fmtShares(v("supply"))} dsSTX2 | price ${(Number(v("pps")) / 1e15).toFixed(9)} (1.0 at launch)`);
    console.log(`realized P&L ${fmtStx(v("realized-pnl"))} STX | high-water price ${(Number(v("hwm-pps")) / 1e15).toFixed(9)} | sweep reference ${(Number(v("sweep-ref-pps")) / 1e15).toFixed(9)}`);
    const bal = await ro("get-balance", [Cl.principal(w.address)], TOKEN);
    console.log(`operator shares: ${fmtShares(bal.value.value)}`);
    return;
  }

  const principals = () => validatePrincipals(
    { admin: flagVal("admin"), strategy: flagVal("strategy"), guardian: flagVal("guardian"), feeRecipient: flagVal("fee-recipient") },
    { network, deployer: w.address, allowHotAdmin: flags.has(HOT_ADMIN_OVERRIDE) },
  );
  const callRead = async (contractName: string, fn: string, deployer: string) =>
    fetchCallReadOnlyFunction({
      contractAddress: deployer, contractName, functionName: fn, functionArgs: [],
      network, senderAddress: deployer, client: { baseUrl: apiBase(network) },
    });
  const writeRecord = (path: string, rec: unknown) => {
    mkdirSync("deployments", { recursive: true });
    writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
    console.log(`record: ${path}`);
  };

  if (cmd === "plan" || cmd === "deploy") {
    const roles = principals();
    if (flags.has(HOT_ADMIN_OVERRIDE)) console.log(`WARNING: ${HOT_ADMIN_OVERRIDE} is set: the admin may be the agent hot wallet (testnet only)`);
    const g = gitState(git);
    const sources = sourcesAt(network, g.commit, git);
    const startNonce = await fetchNonce({ address: w.address, network, client: { baseUrl: apiBase(network) } });
    const plan = buildPlan({ network, deployer: w.address, git: g, sources, principals: roles, startNonce, hotWalletAdmin: flags.has(HOT_ADMIN_OVERRIDE) });
    console.log(planText(plan));
    console.log(`plan sha256: ${planSha(plan)}`);
    if (!g.clean) {
      console.log(`\nrefusing: the working tree is dirty:\n  ${g.dirty.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    if (cmd === "plan") {
      console.log(`\nNEXT: deploy with the same roles and --commit=${g.commit}${network === "mainnet" ? ` --yes-mainnet --plan-sha=${planSha(plan)}` : ""}`);
      return;
    }
    checkProceed(plan, g, { commit: flagVal("commit"), yesMainnet: flags.has("--yes-mainnet"), planSha: flagVal("plan-sha") });
    const txs = await buildDeployTxs(plan, sources, w.key);
    const path = existsSync(recordPath(network, new Date())) ? recordPath(network, new Date()).replace(/\.json$/, `-${Date.now()}.json`) : recordPath(network, new Date());
    let txids: { label: string; txid: string }[] = [];
    try {
      txids = await broadcastAll(txs, (transaction) => broadcastTransaction({ transaction, network }));
    } catch (e) {
      txids = (e as any).done ?? [];
      writeRecord(path, deploymentRecord(plan, txids, null, new Date()));
      throw e;
    }
    for (const t of txids) console.log(`${t.label}: txid ${t.txid}`);
    writeRecord(path, deploymentRecord(plan, txids, null, new Date()));
    for (const t of txids) {
      console.log(t.label);
      if (!(await waitForTx(network, t.txid))) throw new Error(`${t.label} did not succeed; record kept at ${path}`);
    }
    const v = await verifyDeployment(plan, (p) => api(network, p), (c, f) => callRead(c, f, plan.deployer));
    for (const c of v.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    writeRecord(path, deploymentRecord(plan, txids, v, new Date()));
    if (!v.ok) { console.log("VERIFY FAILED: do not announce or deposit"); process.exitCode = 1; }
    return;
  }

  if (cmd === "verify") {
    const path = flagVal("record");
    if (!path) throw new Error("usage: verify --record=<deployments/...json>");
    const rec = JSON.parse(readFileSync(path, "utf8")) as { plan: DeployPlan; txids: { label: string; txid: string }[] };
    const plan = rec.plan;
    if (plan.network !== network) throw new Error(`refusing: the record is for ${plan.network}`);
    // The record's hashes must still be the pinned commit's files.
    const atCommit = sourcesAt(network, plan.git.commit, git);
    for (const c of plan.contracts) {
      if (atCommit.find((s) => s.name === c.name)?.deployedSha256 !== c.deployedSha256) throw new Error(`record hash for ${c.name} is not commit ${plan.git.commit}'s file`);
    }
    const v = await verifyDeployment(plan, (p) => api(network, p), (c, f) => callRead(c, f, plan.deployer));
    for (const c of v.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    writeRecord(path, deploymentRecord(plan, rec.txids, v, new Date()));
    if (!v.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "initialize") {
    // Only to finish a deploy that stopped before its initialize; normally deploy runs it.
    const r = principals();
    console.log(`admin ${r.admin}\nstrategy ${r.strategy}\nguardian ${r.guardian}\nfee recipient ${r.feeRecipient}`);
    await send("initialize", [Cl.principal(r.admin), Cl.principal(r.strategy), Cl.principal(r.guardian), Cl.principal(r.feeRecipient)]);
    return;
  }

  if (cmd === "deposit") { const a = ustx(pos[1]); return void (await send("deposit", [Cl.uint(a)], w.key, a)); }
  if (cmd === "request") {
    let shares: bigint;
    if (pos[1] === "all") shares = BigInt((await ro("get-balance", [Cl.principal(w.address)], TOKEN)).value.value);
    else shares = BigInt(pos[1] ?? "0");
    if (shares <= 0n) throw new Error("usage: request <shares in base units|all>");
    console.log(`requesting ${fmtShares(shares)} dsSTX2`);
    return void (await send("request-withdrawal", [Cl.uint(shares)]));
  }
  if (cmd === "claim") return void (await send("claim-withdrawal", [Cl.uint(BigInt(pos[1]))]));
  if (cmd === "claim-deposit") return void (await send("claim-deposit", [Cl.uint(BigInt(pos[1]))]));
  if (cmd === "claim-epoch-withdrawal") return void (await send("claim-epoch-withdrawal", [Cl.uint(BigInt(pos[1]))]));
  if (cmd === "cancel-deposit" || cmd === "cancel-withdrawal") return void (await send(cmd, []));
  if (cmd === "sweep") { const a = ustx(pos[1]); return void (await send("sweep", [Cl.uint(a)], w.key, a)); }
  if (cmd === "return") {
    const amt = pos[1] === "0" ? 0n : ustx(pos[1]);
    return void (await send("return-from-strategy", [Cl.uint(amt)], asStrategy(), amt));
  }
  if (cmd === "recover") { const a = ustx(pos[1]); return void (await send("recover-from-strategy", [Cl.uint(a)], asStrategy(), a)); }
  if (cmd === "settle-overdue") return void (await send("settle-overdue", []));
  if (["pause-deposits", "pause-sweeps", "unpause-deposits", "unpause-sweeps"].includes(cmd ?? "")) return void (await send(cmd!, []));

  if (cmd === "queue" || cmd === "confirm") {
    const param = pos[1];
    const uintParams = ["max-tvl", "fee-bps", "max-deploy-bps"];
    const principalParams = ["fee-recipient", "strategy", "guardian", "admin"];
    if (cmd === "queue") {
      if (param === "resume-sweeps") return void (await send("queue-resume-sweeps", []));
      if (param === "admin") return void (await send("queue-admin-change", [Cl.principal(pos[2])]));
      if (uintParams.includes(param)) return void (await send(`queue-${param}`, [Cl.uint(BigInt(param === "max-tvl" ? ustx(pos[2]) : BigInt(pos[2])))]));
      if (principalParams.includes(param)) return void (await send(`queue-${param}`, [Cl.principal(pos[2])]));
    } else {
      if (param === "resume-sweeps") return void (await send("confirm-resume-sweeps", []));
      if ([...uintParams, ...principalParams].includes(param) && param !== "admin" && param !== "strategy") return void (await send(`confirm-${param}`, []));
    }
    throw new Error(`unknown parameter: ${param}`);
  }
  if (cmd === "accept-admin") return void (await send("accept-admin-change", []));
  if (cmd === "accept-strategy") return void (await send("accept-strategy-change", [], asStrategy()));

  if (cmd === "send-test-stx") {
    if (network !== "testnet") throw new Error("send-test-stx is testnet only");
    const nonce = await fetchNonce({ address: w.address, network, client: { baseUrl: apiBase(network) } });
    const tx = await makeSTXTokenTransfer({ recipient: pos[1], amount: ustx(pos[2]), senderKey: w.key, network, fee: CALL_FEE, nonce });
    const res = await broadcastTransaction({ transaction: tx, network });
    if (!("txid" in res)) throw new Error(`transfer failed: ${JSON.stringify(res)}`);
    console.log(`sent ${pos[2]} test STX to ${pos[1]}: txid ${res.txid}`);
    await waitForTx(network, res.txid);
    return;
  }

  console.log("unknown command. See the header of src/m1/vault-v2-cli.ts for usage.");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("vault-v2-cli failed:", (err as Error).message);
  process.exit(1);
});
